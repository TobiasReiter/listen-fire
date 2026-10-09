// Side-effect: merge the active dev-loop profile's env (WEB_BASE_URL, …)
// into process.env so this agent targets the running stack (e.g. the
// agent profile's :3503) instead of the default :3003. Must precede the
// BASE_URL read below.
import './dev/_profile_loader';

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

import { chromium, type Page, type Browser } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';

import { getAutomationsQb, getCoreQb, getKnowledgeQb, getQb } from '../lib/kysely';
import { materializeTemplate } from '../lib/knowledge/templates/materialize';
import { getTemplate } from '../lib/knowledge/templates/index';
import { generateJWT } from '../lib/middleware/authentication/token';
import { encryptToken } from '../lib/credentials';
import { getEnvVar } from '../lib/utils/environment';

import type { TeamId } from '../generated/kysely/core/Team';
import type { PipelineConfigurationId } from '../generated/kysely/public/PipelineConfiguration';
import type { ExternalServiceCredentialsId } from '../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../generated/kysely/automations/ExternalServiceType';

import type { OntologyTemplate } from '../lib/knowledge/templates/types';

// ── Config ──────────────────────────────────────────────────

const BASE_URL =
  process.env.UI_TEST_BASE_URL || process.env.WEB_BASE_URL || 'http://localhost:3003';
const SCREENSHOT_DIR = '/tmp/ui_test_agent';
const MAX_TURNS = 120;
const MODEL = 'claude-sonnet-5';
const TEST_EMAIL = 'ui-test-agent@listen-fire.local';
const TEST_TEAM_NAME = 'UI Test Agent';

// ── Types ───────────────────────────────────────────────────

type ToolResult = string | Anthropic.ToolResultBlockParam['content'];

interface Verdict {
  verdict: 'PASS' | 'FAIL' | 'BLOCKED';
  reason: string;
}

// ── Agent Loop ──────────────────────────────────────────────

const apiKey = getEnvVar('ANTHROPIC_API_KEY', { devDefault: 'test' });
const anthropic = new Anthropic({ apiKey });

async function runAgentLoop(options: {
  system: string;
  userMessage: string;
  tools: Anthropic.Tool[];
  toolImpls: Record<string, (args: any) => Promise<ToolResult>>;
}): Promise<Verdict> {
  const { system, userMessage, tools, toolImpls } = options;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const start = Date.now();

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system,
      tools,
      messages,
    });

    const elapsed = Date.now() - start;
    const usage = response.usage;

    // Extract text and tool use blocks
    const textBlocks: string[] = [];
    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === 'text') textBlocks.push(block.text);
      else if (block.type === 'tool_use') toolUseBlocks.push(block);
    }

    const thinking = textBlocks.join('\n').slice(0, 300);
    const toolNames = toolUseBlocks.map((b) => b.name);

    console.log(`\n── Turn ${turn + 1} (${elapsed}ms, ${usage.input_tokens}→${usage.output_tokens} tokens) ──`);
    if (thinking) console.log(`  ${thinking.replace(/\n/g, '\n  ')}`);
    if (toolNames.length) console.log(`  Tools: ${toolNames.join(', ')}`);

    if (response.stop_reason !== 'tool_use' || !toolUseBlocks.length) {
      // Agent stopped without calling done — treat text as the verdict
      const text = textBlocks.join('\n');
      if (text.includes('PASS')) return { verdict: 'PASS', reason: text };
      if (text.includes('FAIL')) return { verdict: 'FAIL', reason: text };
      return { verdict: 'BLOCKED', reason: text || 'Agent stopped without a verdict' };
    }

    // Execute tools and build results
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const tc of toolUseBlocks) {
      // Check for the terminal `done` tool
      if (tc.name === 'done') {
        const input = tc.input as { verdict: string; reason: string };
        const verdict = (['PASS', 'FAIL', 'BLOCKED'].includes(input.verdict) ? input.verdict : 'BLOCKED') as Verdict['verdict'];
        return { verdict, reason: input.reason };
      }

      const impl = toolImpls[tc.name];
      let result: ToolResult;
      try {
        result = impl ? await impl(tc.input) : `Error: Unknown tool "${tc.name}"`;
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: typeof result === 'string' ? result : result,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { verdict: 'BLOCKED', reason: `Reached maximum ${MAX_TURNS} turns without a verdict` };
}

// ── Playwright Tools ────────────────────────────────────────

function buildTools(page: Page) {
  const tools: Anthropic.Tool[] = [
    {
      name: 'screenshot',
      description: 'Take a screenshot of the current page. Use this to see what is on screen.',
      input_schema: {
        type: 'object' as const,
        properties: {
          description: { type: 'string', description: 'Brief label for the screenshot file (e.g. "ontology-graph")' },
        },
        required: ['description'],
      },
    },
    {
      name: 'navigate',
      description: 'Navigate to a URL path in the application.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'URL path (e.g. "/ontology", "/outputs")' },
        },
        required: ['path'],
      },
    },
    {
      name: 'click',
      description: 'Click on an element. Use CSS selector or x/y coordinates from a screenshot.',
      input_schema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'CSS selector (e.g. "button", "[data-testid=save]")' },
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
        },
      },
    },
    {
      name: 'fill',
      description: 'Type text into an input field.',
      input_schema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'CSS selector for the input' },
          value: { type: 'string', description: 'Text to type' },
        },
        required: ['selector', 'value'],
      },
    },
    {
      name: 'get_page_content',
      description: 'Get the visible text content of the page or a specific element. Useful for reading text without a screenshot.',
      input_schema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector to scope the content' },
        },
      },
    },
    {
      name: 'scroll',
      description: 'Scroll the page up or down.',
      input_schema: {
        type: 'object' as const,
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
          pixels: { type: 'number', description: 'Pixels to scroll (default 500)' },
        },
        required: ['direction'],
      },
    },
    {
      name: 'wait',
      description: 'Wait for an element to appear or a fixed delay.',
      input_schema: {
        type: 'object' as const,
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for' },
          milliseconds: { type: 'number', description: 'Fixed delay in ms' },
        },
      },
    },
    {
      name: 'select_option',
      description: 'Select an option from a native <select> dropdown. Find the select by its field label (e.g. "Object Type", "Credentials") or CSS selector. Returns available options if no value/label provided.',
      input_schema: {
        type: 'object' as const,
        properties: {
          fieldLabel: { type: 'string', description: 'The label text near the <select> (e.g. "Object Type", "Credentials", "Type"). Finds the <label> element with this text and the <select> inside the same parent.' },
          selector: { type: 'string', description: 'CSS selector for the <select> element (fallback if fieldLabel not provided)' },
          value: { type: 'string', description: 'The option value to select' },
          optionLabel: { type: 'string', description: 'The visible option text to select (used if value is not provided)' },
          nth: { type: 'number', description: 'If multiple selects match, pick the Nth one (0-indexed, default 0)' },
        },
      },
    },
    {
      name: 'evaluate',
      description: 'Run JavaScript in the browser page context. Returns the JSON-stringified result. Use this for complex interactions that other tools cannot handle, e.g. selecting from dropdowns by label text, reading DOM structure, or triggering React state changes.',
      input_schema: {
        type: 'object' as const,
        properties: {
          script: { type: 'string', description: 'JavaScript expression or function body to evaluate in the page. Use document.querySelector, etc.' },
        },
        required: ['script'],
      },
    },
    {
      name: 'press_key',
      description: 'Press a keyboard key (e.g. "Enter", "Escape", "Tab", "ArrowDown").',
      input_schema: {
        type: 'object' as const,
        properties: {
          key: { type: 'string', description: 'Key to press (e.g. "Enter", "Escape", "Tab", "ArrowDown")' },
        },
        required: ['key'],
      },
    },
    {
      name: 'done',
      description: 'Report your final test verdict and end the session. Call this when you have enough information to judge.',
      input_schema: {
        type: 'object' as const,
        properties: {
          verdict: { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED'], description: 'Test result' },
          reason: { type: 'string', description: 'Explanation of the result' },
        },
        required: ['verdict', 'reason'],
      },
    },
  ];

  const toolImpls: Record<string, (args: any) => Promise<ToolResult>> = {
    screenshot: async ({ description }: { description: string }) => {
      const filename = `${Date.now()}_${description.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
      const filepath = `${SCREENSHOT_DIR}/${filename}`;

      const buffer = await page.screenshot({ fullPage: false });
      await writeFile(filepath, buffer);
      console.log(`    📸 ${filepath}`);

      return [
        { type: 'text' as const, text: `Screenshot saved: ${filepath} (${buffer.length} bytes)` },
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: 'image/png' as const,
            data: buffer.toString('base64'),
          },
        },
      ];
    },

    navigate: async ({ path }: { path: string }) => {
      const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      console.log(`    🧭 ${url}`);
      return `Navigated to ${path}. Current URL: ${page.url()}`;
    },

    click: async ({ selector, x, y }: { selector?: string; x?: number; y?: number }) => {
      if (selector) {
        await page.click(selector, { timeout: 5000 });
        console.log(`    🖱️  click: ${selector}`);
        return `Clicked ${selector}`;
      }
      if (x !== undefined && y !== undefined) {
        await page.mouse.click(x, y);
        console.log(`    🖱️  click: (${x}, ${y})`);
        return `Clicked at (${x}, ${y})`;
      }
      return 'Error: provide either selector or x/y coordinates';
    },

    fill: async ({ selector, value }: { selector: string; value: string }) => {
      await page.fill(selector, value, { timeout: 5000 });
      console.log(`    ⌨️  fill: ${selector} = "${value.slice(0, 40)}"`);
      return `Filled ${selector} with "${value}"`;
    },

    get_page_content: async ({ selector }: { selector?: string }) => {
      const el = selector ? await page.$(selector) : await page.$('body');
      const text = el ? await el.textContent() : '';
      const trimmed = (text ?? '').trim();
      const truncated = trimmed.length > 4000 ? trimmed.slice(0, 4000) + '...[truncated]' : trimmed;
      return truncated || '(empty)';
    },

    scroll: async ({ direction, pixels = 500 }: { direction: 'up' | 'down'; pixels?: number }) => {
      const delta = direction === 'down' ? pixels : -pixels;
      await page.mouse.wheel(0, delta);
      console.log(`    📜 scroll ${direction} ${pixels}px`);
      return `Scrolled ${direction} by ${pixels}px`;
    },

    wait: async ({ selector, milliseconds }: { selector?: string; milliseconds?: number }) => {
      if (selector) {
        await page.waitForSelector(selector, { timeout: 10000 });
        return `Element ${selector} appeared`;
      }
      if (milliseconds) {
        await new Promise((r) => setTimeout(r, milliseconds));
        return `Waited ${milliseconds}ms`;
      }
      return 'Error: provide either selector or milliseconds';
    },

    select_option: async ({ fieldLabel, selector, value, optionLabel, nth = 0 }: {
      fieldLabel?: string; selector?: string; value?: string; optionLabel?: string; nth?: number;
    }) => {
      // Resolve the select element
      let resolvedSelector: string;
      if (fieldLabel) {
        // Find via label text → parent → select
        const selectHandle = await page.evaluateHandle(
          ({ label, nth }) => {
            const labels = Array.from(document.querySelectorAll('label'));
            const matching = labels.filter((l) => l.textContent?.trim().replace(/\s*\*$/, '') === label);
            const target = matching[nth] ?? matching[0];
            if (!target) return null;
            // Select is a sibling or descendant of the label's parent
            return target.parentElement?.querySelector('select') ?? null;
          },
          { label: fieldLabel, nth },
        );
        const selectEl = selectHandle.asElement();
        if (!selectEl) {
          // List available labels to help the agent
          const labels = await page.evaluate(() =>
            Array.from(document.querySelectorAll('label')).map((l) => l.textContent?.trim()).filter(Boolean),
          );
          return `Error: No <select> found near label "${fieldLabel}". Available labels: ${labels.join(', ')}`;
        }

        // If no value/optionLabel, list available options
        if (!value && !optionLabel) {
          const opts = await selectEl.evaluate((sel) =>
            Array.from((sel as HTMLSelectElement).options).map((o) => ({ value: o.value, label: o.textContent?.trim() })),
          );
          console.log(`    📋 select near "${fieldLabel}": listing ${opts.length} options`);
          return `Options for "${fieldLabel}":\n${opts.map((o) => `  - "${o.label}" (value="${o.value}")`).join('\n')}`;
        }

        // Select the option
        if (value) {
          await selectEl.evaluate((sel, val) => {
            (sel as HTMLSelectElement).value = val;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }, value);
        } else if (optionLabel) {
          await selectEl.evaluate((sel, lbl) => {
            const opt = Array.from((sel as HTMLSelectElement).options).find((o) => o.textContent?.trim() === lbl);
            if (opt) { (sel as HTMLSelectElement).value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
          }, optionLabel);
        }
        const selectedText = await selectEl.evaluate((sel) => (sel as HTMLSelectElement).selectedOptions[0]?.textContent?.trim());
        console.log(`    📋 select near "${fieldLabel}" → "${selectedText}"`);
        return `Selected "${selectedText}" in "${fieldLabel}"`;
      }

      if (selector) {
        if (!value && !optionLabel) {
          const opts = await page.evaluate(
            (sel) => Array.from(document.querySelector(sel)?.querySelectorAll('option') ?? []).map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent?.trim() })),
            selector,
          );
          return `Options:\n${opts.map((o) => `  - "${o.label}" (value="${o.value}")`).join('\n')}`;
        }
        if (value) {
          await page.selectOption(selector, { value }, { timeout: 5000 });
        } else if (optionLabel) {
          await page.selectOption(selector, { label: optionLabel }, { timeout: 5000 });
        }
        console.log(`    📋 select: ${selector} → ${value ?? optionLabel}`);
        return `Selected ${value ?? optionLabel} from ${selector}`;
      }

      return 'Error: provide either fieldLabel or selector';
    },

    evaluate: async ({ script }: { script: string }) => {
      const result = await page.evaluate(script);
      const output = JSON.stringify(result, null, 2);
      console.log(`    🔧 eval: ${script.slice(0, 80)}${script.length > 80 ? '...' : ''}`);
      return output;
    },

    press_key: async ({ key }: { key: string }) => {
      await page.keyboard.press(key);
      console.log(`    ⌨️  key: ${key}`);
      return `Pressed ${key}`;
    },
  };

  return { tools, toolImpls };
}

// ── Test Team Seeding ───────────────────────────────────────

async function seedTestTeam(): Promise<{ teamId: TeamId; token: string; template: OntologyTemplate }> {
  const qb = getCoreQb(['team', 'user', 'user_email']);

  // Check for existing test team
  const existingTeam = await qb
    .selectFrom('team')
    .where('team.name', '=', TEST_TEAM_NAME)
    .select(['team.id'])
    .executeTakeFirst();

  if (existingTeam) {
    const teamId = existingTeam.id as TeamId;

    // Ensure pipeline configuration exists
    const existingConfig = await getCoreQb(['team'])
      .selectFrom('team')
      .where('id', '=', teamId)
      .select('active_pipeline_configuration_id')
      .executeTakeFirst();
    if (!existingConfig?.active_pipeline_configuration_id) {
      const configId = randomUUID() as PipelineConfigurationId;
      await getQb(['pipeline_configuration'])
        .insertInto('pipeline_configuration')
        .values({ id: configId, name: 'Test Configuration', team_id: teamId } as any)
        .execute();
      await getCoreQb(['team'])
        .updateTable('team')
        .set({ active_pipeline_configuration_id: configId })
        .where('id', '=', teamId)
        .execute();
      console.log(`   Added pipeline configuration: ${configId}`);
    }

    // Ensure mock credentials exist
    if (process.env.MOCK_OUTPUT_ADAPTERS === 'true') {
      const existingCreds = await getAutomationsQb(['external_service_credentials'])
        .selectFrom('external_service_credentials')
        .where('team_id', '=', teamId)
        .where('type', '=', ExternalServiceType.ATTIO)
        .select('id')
        .executeTakeFirst();
      if (!existingCreds) {
        const credId = randomUUID() as ExternalServiceCredentialsId;
        const encrypted = await encryptToken(JSON.stringify({ accessToken: 'mock-attio-token' }), credId);
        await getAutomationsQb(['external_service_credentials'])
          .insertInto('external_service_credentials')
          .values({
            id: credId,
            name: 'Mock Attio',
            type: ExternalServiceType.ATTIO,
            credentials: encrypted,
            team_id: teamId,
          } as any)
          .execute();
        console.log(`   Added mock Attio credentials: ${credId}`);
      }
    }

    const token = generateJWT(TEST_EMAIL);
    console.log(`♻️  Reusing test team: ${teamId}`);
    return { teamId, token, template: getTemplate('vc-dealflow')! };
  }

  // Create team
  const teamId = randomUUID() as TeamId;
  await qb.insertInto('team').values({
    id: teamId,
    name: TEST_TEAM_NAME,
  }).execute();

  // Create user (platform admin — the admin surfaces gate on the flag)
  const userId = randomUUID();
  await qb.insertInto('user').values({
    id: userId,
    default_team_id: teamId,
    username: 'ui-test-agent',
    granted_access_at: new Date(),
    is_platform_admin: true,
  } as any).execute();

  // Create user_email
  await qb.insertInto('user_email').values({
    id: randomUUID(),
    user_id: userId,
    email: TEST_EMAIL,
    is_primary: true,
  } as any).execute();

  // Membership, not the team column: `default_team_id` says where the agent
  // lands, `team_membership` is what lets it act there (C-6).
  await getCoreQb(['team_membership']).insertInto('team_membership').values({
    id: randomUUID(),
    user_id: userId,
    team_id: teamId,
    access: 'write',
  } as any).execute();

  // Materialize ontology
  const matQb = getKnowledgeQb(['node_type', 'property_type', 'edge_type', 'extraction_graph', 'extraction_graph_node', 'extraction_graph_edge']);
  const result = await (matQb as any).transaction().execute((trx: any) =>
    materializeTemplate(trx, teamId, 'vc-dealflow'),
  );
  console.log(`🌱 Created test team: ${teamId}`);
  console.log(`   ${result.nodeTypesCreated} node types, ${result.edgeTypesCreated} edge types, ${result.extractionGraphsCreated} extraction graphs`);

  // Create pipeline configuration
  const configId = randomUUID() as PipelineConfigurationId;
  await getQb(['pipeline_configuration'])
    .insertInto('pipeline_configuration')
    .values({ id: configId, name: 'Test Configuration', team_id: teamId } as any)
    .execute();
  await getCoreQb(['team'])
    .updateTable('team')
    .set({ active_pipeline_configuration_id: configId })
    .where('id', '=', teamId)
    .execute();
  console.log(`   Pipeline configuration: ${configId}`);

  // Create mock Attio credentials
  if (process.env.MOCK_OUTPUT_ADAPTERS === 'true') {
    const credId = randomUUID() as ExternalServiceCredentialsId;
    const encrypted = await encryptToken(JSON.stringify({ accessToken: 'mock-attio-token' }), credId);
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({
        id: credId,
        name: 'Mock Attio',
        type: 'ATTIO',
        credentials: encrypted,
        team_id: teamId,
      } as any)
      .execute();
    console.log(`   Mock Attio credentials: ${credId}`);
  }

  const token = generateJWT(TEST_EMAIL);
  return { teamId, token, template: getTemplate('vc-dealflow')! };
}

// ── Auth Injection ──────────────────────────────────────────

async function injectAuth(page: Page, teamId: string, token: string) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });

  await page.evaluate(
    ({ token, email, teamId }) => {
      localStorage.setItem(
        '__LISTEN_FIRE__',
        JSON.stringify({
          tokenState: { token, email },
          users: [{ email, selectedTeamId: teamId }],
        }),
      );
    },
    { token, email: TEST_EMAIL, teamId },
  );

  await page.reload({ waitUntil: 'networkidle', timeout: 15000 });
  console.log('🔑 Auth injected');
}

// ── System Prompt ───────────────────────────────────────────

function buildSystemPrompt(template: OntologyTemplate, brief: string): string {
  const nodeTypes = template.nodeTypes
    .map((nt) => `  - ${nt.name} (${nt.category}): ${nt.description}`)
    .join('\n');

  const edgeTypes = template.edgeTypes
    .map((et) => `  - ${et.outboundName} / ${et.inboundName}: ${et.source} → ${et.target} — ${et.description}`)
    .join('\n');

  return `You are a QA testing agent for a knowledge graph application.

# Application
- URL: ${BASE_URL}
- Framework: Next.js (React) with Tailwind CSS
- Purpose: Knowledge graph UI for entity extraction and relationship tracking

# Seeded Ontology (VC Dealflow template)

Node types:
${nodeTypes}

Edge types:
${edgeTypes}

# Key Pages
- /ontology — Graph view of the ontology (node types and edge types)
- /ask — Knowledge query chat interface
- /inputs — Pipeline input configuration
- /outputs — Pipeline output configuration
- /messages/:id — Message type detail
- /objects/:id — Object type detail
- /integrations — Integration management

# Your Task
${brief}

# UI Patterns
- All dropdowns are native HTML <select> elements wrapped in a <div> with a <label> sibling
- Use the select_option tool with fieldLabel to interact with them (e.g. fieldLabel="Object Type")
- Call select_option with just fieldLabel (no value) to list available options first
- The field mapping "Select field..." dropdown is inside the field mapping row, not directly labeled — use selector="select" with nth to target it, or use evaluate to find it
- Clicking "Object" in the left panel's ADD ACTION section adds a root Object node to the canvas
- The "+" button on canvas nodes opens the Add Linked Action modal for child nodes
- After adding/configuring nodes, click "Save" (top-right) to persist

# Instructions
1. Start by taking a screenshot to see the current state of the page
2. Navigate, click, fill forms, and interact as needed to test the brief
3. Take screenshots after key actions to verify state changes
4. For dropdowns: use select_option with fieldLabel — never use evaluate for selects
5. When you have enough evidence, call the "done" tool with your verdict
6. If something doesn't load, wait 2-3 seconds and retry once

Be efficient. Minimize turns by combining related observations. Don't take screenshots unless you need to verify something changed.`;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const headless = args.includes('--headless');
  const brief = args.filter((a) => !a.startsWith('--')).join(' ');

  if (!brief) {
    console.error('Usage: pnpm ui:test "<brief>" [--headless]');
    console.error('');
    console.error('Examples:');
    console.error('  pnpm ui:test "Navigate to /ontology and verify the graph renders"');
    console.error('  pnpm ui:test "Check that the outputs page loads" --headless');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  UI Testing Agent');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Brief: ${brief}`);
  console.log(`Mode: ${headless ? 'headless' : 'headful (watch the browser)'}`);
  console.log('');

  // 1. Seed test team
  console.log('── Setup ──');
  const { teamId, token, template } = await seedTestTeam();

  // 2. Create screenshot directory
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  // 3. Launch browser
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless,
      args: ['--no-sandbox'],
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });

    const page = await context.newPage();

    // 4. Inject auth
    await injectAuth(page, teamId, token);

    // 5. Build tools and system prompt
    const { tools, toolImpls } = buildTools(page);
    const systemPrompt = buildSystemPrompt(template, brief);

    // 6. Run agent
    console.log('\n── Agent Loop ──');
    const result = await runAgentLoop({
      system: systemPrompt,
      userMessage: 'Begin testing. Take a screenshot first to see the current state of the application.',
      tools,
      toolImpls,
    });

    // 7. Report
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`  Result: ${result.verdict}`);
    console.log('═══════════════════════════════════════════════════════');
    console.log(result.reason);
    console.log(`\nScreenshots: ${SCREENSHOT_DIR}/`);

    await browser.close();

    if (result.verdict === 'PASS') process.exit(0);
    if (result.verdict === 'FAIL') process.exit(1);
    process.exit(2);
  } catch (error) {
    console.error('\n❌ Agent crashed:', error);
    if (browser) await browser.close();
    process.exit(3);
  }
}

main();
