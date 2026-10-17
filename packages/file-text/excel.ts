import { Readable } from 'node:stream';

import ExcelJS from 'exceljs';
import { Parser as FormulaParser } from 'hot-formula-parser';

/** The model call that reads a sheet's layout: the host picks the model and
 *  meters the call; the answer is the model's JSON text. */
type SheetAnalyzer = (request: {
  temperature: number;
  system: string;
  userMessage: string;
}) => Promise<string>;


// Raw cell value type
type CellValue = string | number | boolean | null;

// A 2D grid of cell values with optional formulas
interface CellData {
  value: CellValue;
  formula?: string;
}
type Grid = CellData[][];

// Semantic block types identified by LLM
type BlockType = 'header' | 'metadata' | 'table' | 'note';

// LLM-identified semantic block
interface SemanticBlock {
  type: BlockType;
  startRow: number;
  endRow: number;
  startCol?: number;
  endCol?: number;
  description: string;
  headerRows?: number[];
  labelColumn?: number; // Column index containing row labels (e.g., entity names) - deprecated, use labelColumns
  labelColumns?: number[]; // Column indices containing hierarchical row labels (e.g., [0, 1, 2] for 3-level hierarchy)
  inheritsHeadersFrom?: number; // startRow of another table to inherit headers from
}

// Output area types
interface HeaderArea {
  type: 'header';
  text: string;
}

interface MetadataArea {
  type: 'metadata';
  description?: string;
  values: Record<string, CellValue>;
}

interface TableArea {
  type: 'table';
  description?: string;
  rows: Record<string, CellValue>[];
}

interface NoteArea {
  type: 'note';
  text: string;
}

type Area = HeaderArea | MetadataArea | TableArea | NoteArea;

// Output format for a sheet
interface SheetData {
  name: string;
  areas: Area[];
}

// Final output format
interface ExcelContent {
  sheets: SheetData[];
}

const SYSTEM_PROMPT = `You are an expert at analyzing spreadsheet structure. Your task is to identify semantic blocks in spreadsheet data and determine the best way to extract structured information.

CORE PRINCIPLES:

1. ENTITY vs VALUE DISTINCTION
   - Entity names (companies, people, funds, products) are ROW LABELS, not column headers
   - Numbers, percentages, currency amounts, and dates are VALUES, not headers
   - If a column contains mixed entity names, it's a label column identifying rows
   - Headers describe what kind of value is in the column (e.g., "Investment Amount", "Ownership %")
   - HIERARCHICAL LABELS: Some spreadsheets have multiple label columns forming a hierarchy
     Example: Column A="ARR Per Geo", Column B="Tied-in ARR", Column C="DK" → these form a 3-level hierarchy
     Use labelColumns: [0, 1, 2] to capture all label columns in order

2. OVERLAPPING/ADJACENT TABLES
   - Spreadsheets often have multiple logical tables sharing a label column
   - Example: Columns A-D might be "Pre-Round Data" and columns A, E-H might be "Post-Round Data", both sharing column A as the entity name
   - When you see this pattern, identify separate tables with their column ranges, noting the shared label column
   - Each table should make semantic sense on its own

3. HEADER DETECTION
   - Headers are typically short text labels describing the data below
   - Headers may span multiple rows (hierarchical): a group label above specific column labels
   - If a column has data but no sensible header, use the column letter (A, B, C...)
   - Never use a data value as a header - if row 1 contains "US$100,000", that's data, not a header

4. CONTINUATION TABLES (Column Inheritance)
   - When rows appear below a main table with no new headers but use the SAME column positions, they are a CONTINUATION
   - Mark these with inheritsHeadersFrom pointing to the main table's startRow
   - Example: A totals row, an "Option Pool" section, or summary rows that use the same column layout
   - The continuation will inherit the column structure from the referenced table

5. METADATA vs TABLE DISTINCTION (Critical)
   - Use "metadata" for key-value pairs with NO repeated structure:
     * Vertical pairs: Label in one row, value below (or label: value in adjacent cells)
     * Example: "Pre-money" / "US$8M" in consecutive rows or adjacent cells
     * Example: "Share split" / "100,000" as a single definition
     * Example: "Share Class: Seed Shares", "Nominal Value: US$0.0000100"
   - Use "table" ONLY when there are multiple DATA rows (not just header rows)
     * A table must have at least one row of actual data values below the headers
     * If a block only has 1-2 rows that define properties/attributes, it's metadata
   - When in doubt: if all the content would end up in "headers" with no data rows, use metadata

6. BLOCK TYPES
   - "header": Document/section title (usually standalone text at top, like a company name)
   - "metadata": Key-value pairs, definitions, or property blocks (label-value structure, no repeated rows)
   - "table": Structured data with headers AND multiple data rows below
   - "note": Standalone text that provides context (footnotes, disclaimers, section labels)

7. SPARSE DATA
   - Financial spreadsheets often have sparse columns (many empty cells)
   - A column with only a few values is still a valid column if those values are meaningful
   - Empty cells in a row just mean that attribute doesn't apply to that entity`;

const USER_PROMPT_TEMPLATE = `Analyze this spreadsheet and identify all semantic blocks.

SPREADSHEET CONTENT:
{preview}

INSTRUCTIONS:
1. First, identify what kind of document this is (cap table, financial model, etc.)
2. Look for the logical sections/blocks and their boundaries
3. For tables, identify:
   - Which rows contain headers (may be multiple rows for hierarchical headers)
   - Which column contains entity/row labels (names of things)
   - Whether there are multiple tables sharing a label column (overlapping tables)
   - The column range for each table
4. For any data that looks like key-value pairs, mark as metadata
5. Section titles and standalone labels should be marked as notes or headers

OUTPUT FORMAT:
Return a JSON array of blocks. Each block has:
- type: "header" | "metadata" | "table" | "note"
- startRow: 0-indexed first row
- endRow: 0-indexed last row (inclusive)
- startCol: (optional) 0-indexed first column, if table doesn't span full width
- endCol: (optional) 0-indexed last column
- description: Brief description of what this block contains
- headerRows: (tables only) Array of row indices containing headers
- labelColumn: (tables only) Single column index containing entity names (use labelColumns for multiple)
- labelColumns: (tables only) Array of column indices for hierarchical row labels, e.g., [0, 1, 2] for 3-level hierarchy
- inheritsHeadersFrom: (optional) startRow of another table block whose headers this block should inherit

For overlapping tables sharing a label column, output multiple table blocks with the same labelColumn but different startCol/endCol ranges.

For continuation sections (like option pools or totals) that use the same column structure as the main table above, use inheritsHeadersFrom to reference the main table.

Return ONLY the JSON array.`;

/**
 * Extracts content from an XLSX or CSV file as structured JSON using
 * LLM-based semantic analysis for accurate structure detection.
 */
async function getXlsxContent(
  docStream: Readable,
  filename: string | undefined,
  analyze: SheetAnalyzer,
): Promise<string> {
  const workbook = new ExcelJS.Workbook();

  if (filename?.toLowerCase().endsWith('.csv')) {
    await workbook.csv.read(docStream);
  } else {
    await workbook.xlsx.read(docStream);
  }

  const content: ExcelContent = { sheets: [] };

  for (const worksheet of workbook.worksheets) {
    const grid = worksheetToGrid(worksheet);
    if (grid.length === 0) continue;

    evaluateFormulas(grid);

    const blocks = await identifySemanticBlocks(grid, analyze);
    const areas: Area[] = [];

    for (const block of blocks) {
      let area = structureBlock(grid, block, blocks);
      if (area) {
        // Convert empty tables to metadata (safety net for LLM misclassification)
        area = convertEmptyTableToMetadata(area, grid, block);
        areas.push(area);
      }
    }

    if (areas.length > 0) {
      content.sheets.push({ name: worksheet.name, areas });
    }
  }

  return serializeAsMarkdown(content);
}

/**
 * Serialize content as Markdown with embedded JSON for structured data.
 * This balances token efficiency (markdown structure) with LLM comprehension (JSON for data).
 */
function serializeAsMarkdown(content: ExcelContent): string {
  const lines: string[] = [];

  for (const sheet of content.sheets) {
    lines.push(`# ${sheet.name}`);
    lines.push('');

    for (const area of sheet.areas) {
      switch (area.type) {
        case 'header':
          lines.push(`## ${area.text}`);
          break;

        case 'metadata':
          if (area.description) {
            lines.push(`### ${area.description}`);
          }
          lines.push('```json');
          lines.push(JSON.stringify(area.values, null, 2));
          lines.push('```');
          break;

        case 'table':
          if (area.description) {
            lines.push(`### ${area.description}`);
          }
          lines.push('```json');
          lines.push(JSON.stringify(area.rows, null, 2));
          lines.push('```');
          break;

        case 'note':
          lines.push(`> ${area.text}`);
          break;
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Convert an ExcelJS worksheet to a 2D grid.
 */
function worksheetToGrid(worksheet: ExcelJS.Worksheet): Grid {
  const grid: Grid = [];
  let maxCol = 0;

  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const rowValues: CellData[] = [];

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      while (rowValues.length < colNumber - 1) {
        rowValues.push({ value: null });
      }
      rowValues[colNumber - 1] = getCellData(cell);
      maxCol = Math.max(maxCol, colNumber);
    });

    while (grid.length < rowNumber - 1) {
      grid.push([]);
    }
    grid[rowNumber - 1] = rowValues;
  });

  for (let i = 0; i < grid.length; i++) {
    while (grid[i].length < maxCol) {
      grid[i].push({ value: null });
    }
  }

  return grid;
}

/**
 * Format a number based on Excel number format string.
 */
function formatNumberWithNumFmt(value: number, numFmt: string | undefined): string | number {
  if (!numFmt) return value;

  // Percentage format
  if (numFmt.includes('%')) {
    const percentage = value * 100;
    // Determine decimal places from format
    const match = numFmt.match(/0\.(0+)%/);
    const decimals = match ? match[1].length : 2;
    return `${percentage.toFixed(decimals)}%`;
  }

  // Currency formats
  if (
    numFmt.includes('$') ||
    numFmt.includes('£') ||
    numFmt.includes('€') ||
    numFmt.includes('¥')
  ) {
    const symbol = numFmt.match(/[$£€¥]/)?.[0] || '$';
    // For small values, preserve significant figures instead of fixed 2 decimals
    if (Math.abs(value) < 0.01 && value !== 0) {
      // Use toPrecision for small values to preserve sig figs
      const formatted = value.toPrecision(4).replace(/\.?0+$/, '');
      return `${symbol}${formatted}`;
    }
    return `${symbol}${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // Number with thousands separator
  if (numFmt.includes(',') || numFmt.includes('#,##0')) {
    return value.toLocaleString('en-US');
  }

  return value;
}

/**
 * Extract cell data including value and formula.
 */
function getCellData(cell: ExcelJS.Cell): CellData {
  const value = cell.value;
  let formula: string | undefined;
  let cellValue: CellValue = null;

  if (value === null || value === undefined) {
    return { value: null };
  }

  if (typeof value === 'object' && value !== null && 'formula' in value) {
    const formulaValue = value as ExcelJS.CellFormulaValue;
    formula = formulaValue.formula;
    const result = formulaValue.result;

    // Format numbers using numFmt
    if (typeof result === 'number') {
      const formatted = formatNumberWithNumFmt(result, cell.numFmt);
      return { value: formatted, formula };
    }

    if (result === null || result === undefined) {
      cellValue = null;
    } else if (result instanceof Date) {
      cellValue = formatDateWithNumFmt(result, cell.numFmt);
    } else if (typeof result === 'object') {
      if ('richText' in result) {
        cellValue = (result as ExcelJS.CellRichTextValue).richText.map((rt) => rt.text).join('');
      } else if ('error' in result) {
        cellValue = null;
      } else {
        cellValue = cell.text || null;
      }
    } else {
      cellValue = result as CellValue;
    }

    return { value: cellValue, formula };
  }

  if (typeof value === 'object' && value !== null && 'sharedFormula' in value) {
    const sharedValue = value as ExcelJS.CellSharedFormulaValue;
    formula = sharedValue.sharedFormula;
    const result = sharedValue.result;

    // Format numbers using numFmt
    if (typeof result === 'number') {
      const formatted = formatNumberWithNumFmt(result, cell.numFmt);
      return { value: formatted, formula };
    }

    if (result !== null && result !== undefined && typeof result !== 'object') {
      cellValue = result as CellValue;
    }
    return { value: cellValue, formula };
  }

  if (typeof value === 'object' && value !== null && 'richText' in value) {
    cellValue = (value as ExcelJS.CellRichTextValue).richText.map((rt) => rt.text).join('');
    return { value: cellValue };
  }

  if (typeof value === 'object' && value !== null && 'hyperlink' in value) {
    const hyperlink = value as ExcelJS.CellHyperlinkValue;
    cellValue = hyperlink.text ?? hyperlink.hyperlink;
    return { value: cellValue };
  }

  if (value instanceof Date) {
    return { value: formatDateWithNumFmt(value, cell.numFmt) };
  }

  if (typeof value === 'object' && value !== null && 'error' in value) {
    return { value: null };
  }

  if (typeof value === 'number') {
    const formatted = formatNumberWithNumFmt(value, cell.numFmt);
    return { value: formatted };
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return { value };
  }

  if (typeof value === 'object') {
    return { value: cell.text || null };
  }

  return { value: String(value) };
}

/**
 * Format a date based on Excel number format string.
 * Common Excel date formats:
 * - "mmm-yy" or "mmm-yyyy" → "Dec-24" or "Dec-2024"
 * - "mmmm yyyy" → "December 2024"
 * - "mm/dd/yyyy" or "dd/mm/yyyy" → "12/15/2024"
 * - "yyyy-mm-dd" → "2024-12-15"
 */
function formatDateWithNumFmt(date: Date, numFmt: string | undefined): string | null {
  if (isNaN(date.getTime())) {
    return null;
  }

  if (!numFmt) {
    return date.toISOString().split('T')[0];
  }

  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const fullMonths = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const shortYear = String(year).slice(-2);

  // Month-Year formats: "mmm-yy", "mmm-yyyy", "mmm yy"
  if (/mmm+[-\s]y{2,4}/i.test(numFmt)) {
    const monthStr = numFmt.includes('mmmm') ? fullMonths[month] : months[month];
    const yearStr = numFmt.includes('yyyy') ? String(year) : shortYear;
    const separator = numFmt.includes('-') ? '-' : ' ';
    return `${monthStr}${separator}${yearStr}`;
  }

  // Year-Month formats: "yyyy-mm", "yy-mm"
  if (/y{2,4}[-\/]mm(?!m)/i.test(numFmt)) {
    const yearStr = numFmt.includes('yyyy') ? String(year) : shortYear;
    const monthNum = String(month + 1).padStart(2, '0');
    const separator = numFmt.includes('/') ? '/' : '-';
    return `${yearStr}${separator}${monthNum}`;
  }

  // Quarter format (rare but possible)
  if (/Q/i.test(numFmt)) {
    const quarter = Math.floor(month / 3) + 1;
    return `Q${quarter} ${year}`;
  }

  // Full date with slashes or dashes: mm/dd/yyyy, dd/mm/yyyy, yyyy-mm-dd
  if (/[dmy]{1,4}[-\/][dmy]{1,4}[-\/][dmy]{1,4}/i.test(numFmt)) {
    const dayStr = String(day).padStart(2, '0');
    const monthNum = String(month + 1).padStart(2, '0');

    // Determine order from format
    if (/^y/i.test(numFmt)) {
      // yyyy-mm-dd
      return `${year}-${monthNum}-${dayStr}`;
    } else if (/^d/i.test(numFmt)) {
      // dd/mm/yyyy
      const sep = numFmt.includes('/') ? '/' : '-';
      return `${dayStr}${sep}${monthNum}${sep}${year}`;
    } else {
      // mm/dd/yyyy (default US format)
      const sep = numFmt.includes('/') ? '/' : '-';
      return `${monthNum}${sep}${dayStr}${sep}${year}`;
    }
  }

  // Default to ISO format
  return date.toISOString().split('T')[0];
}

/**
 * Evaluate formulas that don't have cached results.
 */
function evaluateFormulas(grid: Grid): void {
  const parser = new FormulaParser();

  parser.on(
    'callCellValue',
    (
      cellCoord: { row: { index: number }; column: { index: number } },
      done: (value: CellValue) => void,
    ) => {
      const row = cellCoord.row.index;
      const col = cellCoord.column.index;

      if (row >= 0 && row < grid.length && col >= 0 && col < grid[row].length) {
        done(grid[row][col].value);
      } else {
        done(null);
      }
    },
  );

  parser.on(
    'callRangeValue',
    (
      startCoord: { row: { index: number }; column: { index: number } },
      endCoord: { row: { index: number }; column: { index: number } },
      done: (values: CellValue[][]) => void,
    ) => {
      const values: CellValue[][] = [];

      for (let r = startCoord.row.index; r <= endCoord.row.index; r++) {
        const rowValues: CellValue[] = [];
        for (let c = startCoord.column.index; c <= endCoord.column.index; c++) {
          if (r >= 0 && r < grid.length && c >= 0 && c < grid[r].length) {
            rowValues.push(grid[r][c].value);
          } else {
            rowValues.push(null);
          }
        }
        values.push(rowValues);
      }

      done(values);
    },
  );

  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const cell = grid[r][c];
      if (cell.formula && cell.value === null) {
        try {
          const result = parser.parse(cell.formula);
          if (!result.error && result.result !== null) {
            cell.value = result.result as CellValue;
          }
        } catch {
          // Formula evaluation failed
        }
      }
    }
  }
}

/**
 * Create a text preview of the grid for LLM analysis.
 * Includes column letters for reference.
 */
function gridToPreview(grid: Grid, maxRows = 60): string {
  const lines: string[] = [];
  const rowsToShow = Math.min(grid.length, maxRows);

  // Header line with column letters
  const colCount = Math.max(...grid.map((r) => r.length));
  const colLetters = Array.from({ length: colCount }, (_, i) => columnLetter(i + 1));
  lines.push(`Columns: ${colLetters.join(', ')}`);
  lines.push('');

  for (let r = 0; r < rowsToShow; r++) {
    const row = grid[r];
    const cells: string[] = [];

    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell.value !== null && cell.value !== '') {
        const val =
          typeof cell.value === 'string' && cell.value.length > 40
            ? cell.value.substring(0, 40) + '...'
            : cell.value;
        cells.push(`${columnLetter(c + 1)}=${JSON.stringify(val)}`);
      }
    }

    if (cells.length > 0) {
      lines.push(`Row ${r}: ${cells.join(', ')}`);
    } else {
      lines.push(`Row ${r}: (empty)`);
    }
  }

  if (grid.length > maxRows) {
    lines.push(`... (${grid.length - maxRows} more rows)`);
  }

  return lines.join('\n');
}

/**
 * Parse JSON response from LLM, handling markdown code blocks.
 */
function parseJsonResponse(response: string): SemanticBlock[] {
  let jsonStr = response.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(jsonStr) as SemanticBlock[];
}

/**
 * Use LLM to identify semantic blocks in the spreadsheet.
 * Includes retry logic with higher temperature if JSON parsing fails.
 */
async function identifySemanticBlocks(grid: Grid, analyze: SheetAnalyzer): Promise<SemanticBlock[]> {
  const preview = gridToPreview(grid);
  const userPrompt = USER_PROMPT_TEMPLATE.replace('{preview}', preview);

  const MAX_RETRIES = 3;
  const TEMPERATURES = [0, 0.3, 0.5];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const temperature = TEMPERATURES[attempt] ?? 0.5;
      const response = await analyze({
        temperature,
        system: SYSTEM_PROMPT,
        userMessage: userPrompt,
      });

      const blocks = parseJsonResponse(response);

      // Normalize labelColumn to labelColumns
      for (const block of blocks) {
        if (block.labelColumn !== undefined && !block.labelColumns) {
          block.labelColumns = [block.labelColumn];
        }
      }

      const validBlocks = blocks
        .filter(
          (b) =>
            typeof b.startRow === 'number' &&
            typeof b.endRow === 'number' &&
            ['header', 'metadata', 'table', 'note'].includes(b.type),
        )
        .sort((a, b) => {
          if (a.startRow !== b.startRow) return a.startRow - b.startRow;
          return (a.startCol ?? 0) - (b.startCol ?? 0);
        });

      return validBlocks;
    } catch (e) {
      const isLastAttempt = attempt === MAX_RETRIES - 1;
      if (isLastAttempt) {
        console.error('LLM semantic analysis failed after retries:', e);
        return [
          {
            type: 'table',
            startRow: 0,
            endRow: grid.length - 1,
            description: 'Full sheet (fallback)',
          },
        ];
      }
      console.warn(
        `LLM semantic analysis attempt ${attempt + 1} failed, retrying with temperature ${TEMPERATURES[attempt + 1]}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Should never reach here, but TypeScript needs this
  return [
    {
      type: 'table',
      startRow: 0,
      endRow: grid.length - 1,
      description: 'Full sheet (fallback)',
    },
  ];
}

/**
 * Find a previous table block that could provide headers for the current block.
 * Looks for tables that end before this block starts and have overlapping column ranges.
 */
function findPreviousTableWithHeaders(
  allBlocks: SemanticBlock[],
  currentBlock: SemanticBlock,
  startCol: number,
  endCol: number,
): SemanticBlock | null {
  // Find table blocks that end before this one starts
  const candidateTables = allBlocks.filter(
    (b) =>
      b.type === 'table' &&
      b.endRow < currentBlock.startRow &&
      b.headerRows &&
      b.headerRows.length > 0,
  );

  if (candidateTables.length === 0) return null;

  // Sort by endRow descending (closest previous table first)
  candidateTables.sort((a, b) => b.endRow - a.endRow);

  // Find a table with overlapping column range
  for (const candidate of candidateTables) {
    const candStartCol = candidate.startCol ?? 0;
    const candEndCol = candidate.endCol ?? Infinity;

    // Check for column overlap
    if (candStartCol <= endCol && candEndCol >= startCol) {
      return candidate;
    }
  }

  return null;
}

/**
 * Structure a block according to its semantic type.
 */
function structureBlock(grid: Grid, block: SemanticBlock, allBlocks: SemanticBlock[]): Area | null {
  // Extract the relevant portion of the grid
  const startRow = Math.max(0, block.startRow);
  const endRow = Math.min(grid.length - 1, block.endRow);
  const startCol = block.startCol ?? 0;
  const endCol = block.endCol ?? (grid[0]?.length ?? 1) - 1;

  let blockGrid = grid.slice(startRow, endRow + 1).map((row) => row.slice(startCol, endCol + 1));

  // Trim empty rows
  while (blockGrid.length > 0 && isRowEmpty(blockGrid[0])) {
    blockGrid = blockGrid.slice(1);
  }
  while (blockGrid.length > 0 && isRowEmpty(blockGrid[blockGrid.length - 1])) {
    blockGrid = blockGrid.slice(0, -1);
  }

  if (blockGrid.length === 0) return null;

  // Trim empty columns
  const colBounds = findColumnBounds(blockGrid);
  if (colBounds[0] === -1) return null;

  const finalGrid = blockGrid.map((row) => row.slice(colBounds[0], colBounds[1] + 1));

  // Adjust labelColumns for trimming (supports both single labelColumn and array labelColumns)
  const rawLabelColumns =
    block.labelColumns ?? (block.labelColumn !== undefined ? [block.labelColumn] : []);
  const adjustedLabelColumns: number[] = [];
  for (const col of rawLabelColumns) {
    const adjustedCol = col - startCol - colBounds[0];
    if (adjustedCol >= 0 && adjustedCol < (finalGrid[0]?.length ?? 0)) {
      adjustedLabelColumns.push(adjustedCol);
    }
  }

  // Adjust headerRows for row trimming
  const adjustedHeaderRows = block.headerRows
    ?.map((r) => r - startRow)
    .filter((r) => r >= 0 && r < finalGrid.length);

  // Resolve inherited headers if specified
  let inheritedHeaders: string[] | undefined;
  if (block.inheritsHeadersFrom !== undefined) {
    const parentBlock = allBlocks.find(
      (b) => b.type === 'table' && b.startRow === block.inheritsHeadersFrom,
    );
    if (parentBlock) {
      inheritedHeaders = resolveHeadersFromBlock(grid, parentBlock, startCol, endCol);
    }
  }

  // Check if headerRows reference rows outside the block (external headers)
  // This happens when headers are defined separately from the data rows
  if (
    !inheritedHeaders &&
    block.type === 'table' &&
    block.headerRows &&
    block.headerRows.length > 0
  ) {
    const minHeaderRow = Math.min(...block.headerRows);
    if (minHeaderRow < startRow) {
      // Headers are external - build them from the full grid
      inheritedHeaders = buildHeadersFromExternalRows(
        grid,
        block.headerRows,
        startCol,
        endCol,
        rawLabelColumns,
      );
    }
  }

  // Auto-detect header inheritance: if this table would have mostly column-letter headers,
  // look for a previous table with the same column range to inherit from
  if (!inheritedHeaders && block.type === 'table') {
    const tentativeHeaderRows =
      adjustedHeaderRows && adjustedHeaderRows.length > 0
        ? adjustedHeaderRows
        : detectHeaderRows(finalGrid, adjustedLabelColumns);
    const tentativeHeaders = buildHeaders(finalGrid, tentativeHeaderRows, adjustedLabelColumns);

    // Count how many headers are just column letters (A, B, C, AA, etc.) or "Name"
    const columnLetterPattern = /^[A-Z]{1,2}$/;
    const poorHeaderCount = tentativeHeaders.filter(
      (h) => columnLetterPattern.test(h) || h === 'Name',
    ).length;
    const totalHeaders = tentativeHeaders.length;

    // If more than half the headers are column letters, try to find a previous table
    if (totalHeaders > 0 && poorHeaderCount / totalHeaders > 0.5) {
      const previousTable = findPreviousTableWithHeaders(allBlocks, block, startCol, endCol);
      if (previousTable) {
        inheritedHeaders = resolveHeadersFromBlock(grid, previousTable, startCol, endCol);
      }
    }
  }

  switch (block.type) {
    case 'header':
      return structureHeader(finalGrid);
    case 'metadata':
      return structureMetadata(finalGrid, block);
    case 'table':
      return structureTable(
        finalGrid,
        block,
        adjustedLabelColumns,
        adjustedHeaderRows,
        inheritedHeaders,
      );
    case 'note':
      return structureNote(finalGrid);
    default:
      return null;
  }
}

/**
 * Resolve headers from a parent table block for inheritance.
 */
function resolveHeadersFromBlock(
  grid: Grid,
  parentBlock: SemanticBlock,
  childStartCol: number,
  childEndCol: number,
): string[] {
  const parentStartCol = parentBlock.startCol ?? 0;
  const parentEndCol = parentBlock.endCol ?? (grid[0]?.length ?? 1) - 1;

  // Build parent's headers
  const parentGrid = grid
    .slice(parentBlock.startRow, parentBlock.endRow + 1)
    .map((row) => row.slice(parentStartCol, parentEndCol + 1));

  // Adjust header rows to be relative to the sliced grid
  const adjustedParentHeaderRows = parentBlock.headerRows
    ?.map((r) => r - parentBlock.startRow)
    .filter((r) => r >= 0 && r < parentGrid.length);

  // Adjust labelColumns for parent's column offset
  const rawLabelColumns =
    parentBlock.labelColumns ??
    (parentBlock.labelColumn !== undefined ? [parentBlock.labelColumn] : []);
  const adjustedLabelColumns = rawLabelColumns
    .map((c) => c - parentStartCol)
    .filter((c) => c >= 0 && c < (parentGrid[0]?.length ?? 0));

  const parentHeaderRows =
    adjustedParentHeaderRows && adjustedParentHeaderRows.length > 0
      ? adjustedParentHeaderRows
      : detectHeaderRows(parentGrid, adjustedLabelColumns);

  const parentHeaders = buildHeaders(parentGrid, parentHeaderRows, adjustedLabelColumns);

  // Map child columns to parent headers
  const childHeaders: string[] = [];
  for (let c = childStartCol; c <= childEndCol; c++) {
    const parentIdx = c - parentStartCol;
    if (parentIdx >= 0 && parentIdx < parentHeaders.length) {
      childHeaders.push(parentHeaders[parentIdx]);
    } else {
      childHeaders.push(columnLetter(c + 1));
    }
  }

  return childHeaders;
}

/**
 * Build headers from external row indices (headers outside the data block).
 */
function buildHeadersFromExternalRows(
  grid: Grid,
  headerRowIndices: number[],
  startCol: number,
  endCol: number,
  labelColumns: number[],
): string[] {
  const colCount = endCol - startCol + 1;

  // Build a mini-grid of just the header rows
  const headerGrid: Grid = headerRowIndices.map((r) => {
    if (r >= 0 && r < grid.length) {
      return grid[r].slice(startCol, endCol + 1);
    }
    return Array.from({ length: colCount }, () => ({ value: null }));
  });

  // Adjust label columns for the slice
  const adjustedLabelColumns = labelColumns
    .filter((c) => c >= startCol && c <= endCol)
    .map((c) => c - startCol);

  // Use relative row indices (0, 1, 2, ...)
  const relativeHeaderRows = headerRowIndices.map((_, i) => i);

  return buildHeaders(headerGrid, relativeHeaderRows, adjustedLabelColumns);
}

function isRowEmpty(row: CellData[]): boolean {
  return row.every((cell) => cell.value === null || cell.value === '');
}

function findColumnBounds(grid: Grid): [number, number] {
  if (grid.length === 0) return [-1, -1];

  const colCount = Math.max(...grid.map((row) => row.length));
  let startCol = -1;
  let endCol = -1;

  for (let c = 0; c < colCount; c++) {
    const hasData = grid.some((row) => {
      const cell = row[c];
      return cell && cell.value !== null && cell.value !== '';
    });
    if (hasData) {
      if (startCol === -1) startCol = c;
      endCol = c;
    }
  }

  return [startCol, endCol];
}

/**
 * Structure a header block.
 */
function structureHeader(grid: Grid): HeaderArea {
  const text = grid
    .flatMap((row) => row.map((c) => c.value))
    .filter((v) => v !== null && v !== '')
    .map(String)
    .join(' ');

  return { type: 'header', text };
}

/**
 * Structure a metadata block as key-value pairs.
 */
function structureMetadata(grid: Grid, block: SemanticBlock): MetadataArea {
  const values: Record<string, CellValue> = {};

  for (const row of grid) {
    const nonEmpty = row
      .map((c, i) => ({ value: c.value, col: i }))
      .filter((c) => c.value !== null && c.value !== '');

    if (nonEmpty.length === 2) {
      // Key-value pair
      const key = String(nonEmpty[0].value)
        .replace(/[:：]$/, '')
        .trim();
      const val = nonEmpty[1].value;
      if (key && !isLikelyValue(key)) {
        values[key] = val;
      }
    } else if (nonEmpty.length === 1) {
      // Check for inline "key: value" pattern
      const text = String(nonEmpty[0].value);
      const colonIdx = text.search(/[:：]/);
      if (colonIdx > 0 && colonIdx < text.length - 1) {
        const key = text.substring(0, colonIdx).trim();
        const val = text.substring(colonIdx + 1).trim();
        if (!isLikelyValue(key)) {
          values[key] = val;
        }
      }
    } else if (nonEmpty.length > 2 && nonEmpty.length % 2 === 0) {
      // Multiple key-value pairs in one row
      for (let i = 0; i < nonEmpty.length - 1; i += 2) {
        const key = String(nonEmpty[i].value)
          .replace(/[:：]$/, '')
          .trim();
        const val = nonEmpty[i + 1].value;
        if (key && !isLikelyValue(key)) {
          values[key] = val;
        }
      }
    }
  }

  return {
    type: 'metadata',
    description: block.description,
    values,
  };
}

/**
 * Check if a string looks like a period/date header (common in financial spreadsheets).
 * These are labels, not values: "Dec-24", "Jan-25", "Q1 2024", "FY2023", "2024", "H1 2024"
 */
function isLikelyDateHeader(text: string): boolean {
  // Month-Year: "Dec-24", "Jan-25", "Dec 2024", "January 2025"
  if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]?\d{2,4}$/i.test(text))
    return true;
  // Quarter: "Q1 2024", "Q4-23", "1Q24"
  if (/^[1-4]?Q[1-4]?[-\s]?\d{2,4}$/i.test(text)) return true;
  // Fiscal year: "FY2024", "FY24", "FY 2024"
  if (/^FY[-\s]?\d{2,4}$/i.test(text)) return true;
  // Half year: "H1 2024", "H2-23", "1H24"
  if (/^[12]?H[12]?[-\s]?\d{2,4}$/i.test(text)) return true;
  // Year only: "2024", "2025" (4-digit years are often column headers)
  if (/^(19|20)\d{2}$/.test(text)) return true;
  // Year-Month: "2024-01", "2024/12"
  if (/^(19|20)\d{2}[-\/](0[1-9]|1[0-2])$/.test(text)) return true;

  return false;
}

/**
 * Check if a string looks like a value rather than a key/label.
 */
function isLikelyValue(text: string): boolean {
  // Date headers are labels, not values
  if (isLikelyDateHeader(text)) return false;

  // Currency
  if (/^[$£€¥]/.test(text) || /[$£€¥][\d,]+/.test(text)) return true;
  // Percentage
  if (/%\s*$/.test(text)) return true;
  // Number with commas
  if (/^[\d,]+(\.\d+)?$/.test(text)) return true;
  // Full date patterns (these are values, not headers): "01/15/2024", "2024-01-15"
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(text)) return true;
  if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(text)) return true;

  return false;
}

/**
 * Structure a table block with proper header and label column handling.
 * Supports multiple label columns for hierarchical row labels.
 */
function structureTable(
  grid: Grid,
  block: SemanticBlock,
  labelColumns: number[],
  headerRows: number[] | undefined,
  inheritedHeaders?: string[],
): TableArea {
  if (grid.length === 0) {
    return { type: 'table', rows: [] };
  }

  // Use inherited headers if provided, otherwise detect/build
  let headers: string[];
  let effectiveHeaderRows: number[];

  if (inheritedHeaders && inheritedHeaders.length > 0) {
    // Use inherited headers - no header rows in this block
    headers = inheritedHeaders;
    effectiveHeaderRows = [];
  } else {
    // Detect header rows if not specified
    effectiveHeaderRows =
      headerRows && headerRows.length > 0 ? headerRows : detectHeaderRows(grid, labelColumns);

    // Build headers
    headers = buildHeaders(grid, effectiveHeaderRows, labelColumns);
  }

  // Build data rows
  const dataStartRow = effectiveHeaderRows.length > 0 ? Math.max(...effectiveHeaderRows) + 1 : 0;
  const rows: Record<string, CellValue>[] = [];

  // For hierarchical labels, track the last non-empty value in each label column
  const lastLabelValues: CellValue[] = labelColumns.map(() => null);

  for (let r = dataStartRow; r < grid.length; r++) {
    const row = grid[r];
    if (isRowEmpty(row)) continue;

    const rowObj: Record<string, CellValue> = {};

    // Build hierarchical name from label columns
    if (labelColumns.length > 0) {
      const nameParts: string[] = [];
      for (let i = 0; i < labelColumns.length; i++) {
        const c = labelColumns[i];
        const value = row[c]?.value;
        if (value !== null && value !== '') {
          lastLabelValues[i] = value;
          // Reset child labels when a parent label changes
          for (let j = i + 1; j < labelColumns.length; j++) {
            lastLabelValues[j] = null;
          }
        }
        if (lastLabelValues[i] !== null) {
          nameParts.push(String(lastLabelValues[i]));
        }
      }
      if (nameParts.length > 0) {
        rowObj['Name'] = nameParts.join(' > ');
      }
    }

    for (let c = 0; c < row.length; c++) {
      // Skip label columns - already handled above
      if (labelColumns.includes(c)) continue;

      const header = headers[c];
      const value = row[c]?.value;

      if (value !== null && value !== '') {
        rowObj[header] = value;
      }
    }

    if (Object.keys(rowObj).length > 0) {
      rows.push(rowObj);
    }
  }

  return {
    type: 'table',
    description: block.description,
    rows,
  };
}

/**
 * Detect header rows using heuristics.
 */
function detectHeaderRows(grid: Grid, labelColumns: number[]): number[] {
  if (grid.length < 2) return [];

  for (let r = 0; r < Math.min(8, grid.length - 1); r++) {
    const row = grid[r];
    const nonEmpty = row.filter((c) => c.value !== null && c.value !== '');

    if (nonEmpty.length === 0) continue;

    // Check if row looks like headers
    const allStrings = nonEmpty.every((c) => typeof c.value === 'string');
    const noValues = nonEmpty.every((c) => !isLikelyValue(String(c.value ?? '')));

    // Check if next row has data values
    let nextHasValues = false;
    if (r + 1 < grid.length) {
      const nextRow = grid[r + 1];
      nextHasValues = nextRow.some((c) => {
        if (c.value === null || c.value === '') return false;
        return typeof c.value === 'number' || isLikelyValue(String(c.value));
      });
    }

    if (allStrings && noValues && nextHasValues) {
      // Check for hierarchical header (grouping row above)
      if (r > 0) {
        const prevRow = grid[r - 1];
        const prevNonEmpty = prevRow.filter((c) => c.value !== null && c.value !== '');
        const prevAllStrings = prevNonEmpty.every((c) => typeof c.value === 'string');
        const prevNoValues = prevNonEmpty.every((c) => !isLikelyValue(String(c.value ?? '')));

        if (
          prevAllStrings &&
          prevNoValues &&
          prevNonEmpty.length > 0 &&
          prevNonEmpty.length <= nonEmpty.length
        ) {
          return [r - 1, r];
        }
      }
      return [r];
    }
  }

  return [];
}

/**
 * Build header strings from header rows.
 */
function buildHeaders(grid: Grid, headerRowIndices: number[], labelColumns: number[]): string[] {
  const colCount = Math.max(...grid.map((row) => row.length));

  if (headerRowIndices.length === 0) {
    // No headers - use column letters, except for label columns
    return Array.from({ length: colCount }, (_, i) => {
      if (labelColumns.includes(i)) {
        return 'Name';
      }
      return columnLetter(i + 1);
    });
  }

  const headers: string[] = [];
  const lastNonEmpty: (string | null)[] = headerRowIndices.map(() => null);

  for (let c = 0; c < colCount; c++) {
    // Label columns get special treatment
    if (labelColumns.includes(c)) {
      headers.push('Name');
      continue;
    }

    const parts: string[] = [];

    for (let hi = 0; hi < headerRowIndices.length; hi++) {
      const r = headerRowIndices[hi];
      const cell = grid[r]?.[c];
      const value = cell?.value;

      if (value !== null && value !== '' && !isLikelyValue(String(value))) {
        const text = String(value).trim();
        lastNonEmpty[hi] = text;
        parts.push(text);
      } else if (hi < headerRowIndices.length - 1 && lastNonEmpty[hi] !== null) {
        // Carry forward grouping headers (not the last header row)
        parts.push(lastNonEmpty[hi]!);
      }
    }

    if (parts.length > 0) {
      // Deduplicate consecutive identical parts
      const dedupedParts: string[] = [];
      for (const part of parts) {
        if (dedupedParts.length === 0 || dedupedParts[dedupedParts.length - 1] !== part) {
          dedupedParts.push(part);
        }
      }
      headers.push(dedupedParts.join(' > '));
    } else {
      // No valid header - use column letter
      headers.push(columnLetter(c + 1));
    }
  }

  // Make headers unique
  const usedNames = new Map<string, number>();
  return headers.map((h, i) => {
    const count = usedNames.get(h) ?? 0;
    usedNames.set(h, count + 1);
    if (count > 0) {
      return `${h} (${columnLetter(i + 1)})`;
    }
    return h;
  });
}

/**
 * Structure a note block.
 */
function structureNote(grid: Grid): NoteArea {
  const text = grid
    .flatMap((row) => row.map((c) => c.value))
    .filter((v) => v !== null && v !== '')
    .map(String)
    .join(' ');

  return { type: 'note', text };
}

function columnLetter(col: number): string {
  let letter = '';
  while (col > 0) {
    const remainder = (col - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

/**
 * Convert a table with no data rows to metadata.
 * This handles cases where the LLM misclassified a key-value block as a table.
 */
function convertEmptyTableToMetadata(area: Area, grid: Grid, block: SemanticBlock): Area {
  if (area.type !== 'table') return area;

  const tableArea = area as TableArea;
  if (tableArea.rows.length > 0) return area;

  // Table has no data rows - convert to metadata by extracting key-value pairs from the block
  const startRow = Math.max(0, block.startRow);
  const endRow = Math.min(grid.length - 1, block.endRow);
  const startCol = block.startCol ?? 0;
  const endCol = block.endCol ?? (grid[0]?.length ?? 1) - 1;

  const values: Record<string, CellValue> = {};

  for (let r = startRow; r <= endRow; r++) {
    const row = grid[r];
    if (!row) continue;

    // Collect non-empty cells in this row within the column range
    const cells: { col: number; value: CellValue }[] = [];
    for (let c = startCol; c <= endCol; c++) {
      const cell = row[c];
      if (cell && cell.value !== null && cell.value !== '') {
        cells.push({ col: c, value: cell.value });
      }
    }

    if (cells.length === 2) {
      // Two cells: treat as key-value pair
      // Accept even if value looks like a label (e.g., "Share Class" / "Seed Shares")
      const key = String(cells[0].value)
        .replace(/[:：]$/, '')
        .trim();
      const val = cells[1].value;
      if (key && !isLikelyValue(key)) {
        values[key] = val;
      }
    } else if (cells.length >= 3 && cells.length <= 6) {
      // Multiple cells: try pairing them as key-value pairs
      for (let i = 0; i < cells.length - 1; i += 2) {
        const key = String(cells[i].value)
          .replace(/[:：]$/, '')
          .trim();
        const val = cells[i + 1].value;
        if (key && !isLikelyValue(key)) {
          values[key] = val;
        }
      }
    } else if (cells.length === 1) {
      // Single cell: check for inline "key: value" pattern
      const text = String(cells[0].value);
      const colonIdx = text.search(/[:：]/);
      if (colonIdx > 0 && colonIdx < text.length - 1) {
        const key = text.substring(0, colonIdx).trim();
        const val = text.substring(colonIdx + 1).trim();
        if (!isLikelyValue(key)) {
          values[key] = val;
        }
      }
    }
  }

  // If we extracted any key-value pairs, return as metadata
  if (Object.keys(values).length > 0) {
    return {
      type: 'metadata',
      description: block.description,
      values,
    };
  }

  // If no key-value pairs found, try to extract from the original grid
  // This handles cases like "Share Class" / "Seed Shares" where both might look like labels
  for (let r = startRow; r <= endRow; r++) {
    const row = grid[r];
    if (!row) continue;

    for (let c = startCol; c < endCol; c++) {
      const keyCell = row[c];
      const valCell = row[c + 1];
      if (
        keyCell?.value &&
        valCell?.value &&
        typeof keyCell.value === 'string' &&
        !isLikelyValue(keyCell.value)
      ) {
        const key = String(keyCell.value)
          .replace(/[:：]$/, '')
          .trim();
        if (key && !values[key]) {
          values[key] = valCell.value;
        }
      }
    }
  }

  if (Object.keys(values).length > 0) {
    return {
      type: 'metadata',
      description: block.description,
      values,
    };
  }

  // Return original if we couldn't convert
  return area;
}

export { getXlsxContent, type SheetAnalyzer };
