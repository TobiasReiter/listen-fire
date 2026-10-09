import { DocumentSourceService } from '..';
import { GoogleDocsService, parsePageBoxLabel } from '../google_docs';
import { NOTION_REGEX } from '#shared/constants/document_sources';

describe('parsePageBoxLabel', () => {
  [
    {
      title: 'first page of a multi-page deck',
      label: 'Page 1 of 14',
      expected: { page: 1, total: 14 },
    },
    {
      title: 'a later page',
      label: 'Page 3 of 14',
      expected: { page: 3, total: 14 },
    },
    {
      title: 'the zoom control label is not a page label',
      label: 'Page zoom control',
      expected: undefined,
    },
    {
      title: 'a thumbnail alt is not a page box label',
      label: 'A thumbnail image for page 3',
      expected: undefined,
    },
  ].forEach(({ title, label, expected }) => {
    it(title, () => {
      expect(parsePageBoxLabel(label)).toEqual(expected);
    });
  });
});

describe('getGoogleFileId', () => {
  [
    {
      title: 'canonical Google drive link',
      url: new URL('https://drive.google.com/file/d/1F4xIfVbTaYU2fnOisAskE1ECj3ioQsgF/view'),
      expected: '1F4xIfVbTaYU2fnOisAskE1ECj3ioQsgF',
    },
    {
      title: 'Google presentation link',
      url: new URL(
        'https://docs.google.com/presentation/d/13Z8ENq-uvaFzKx99yTDp8DfcDqC8sTy35-yH0XlVQ1I/edit',
      ),
      expected: '13Z8ENq-uvaFzKx99yTDp8DfcDqC8sTy35-yH0XlVQ1I',
    },
    {
      title: 'Google presentation link in presentation mode',
      url: new URL(
        'https://docs.google.com/presentation/d/e/2PACX-1vQBqrPoK7uNoGVvVj6SumG1h94DcWeCtNqQzo8UNBw0r6-bBDH-bHF-1TXNkXFxdY6WmkxwRjghAQs7/pub?start=false&loop=false&delayms=3000&slide=id.g249dce9248b_0_38',
      ),
      expected:
        '2PACX-1vQBqrPoK7uNoGVvVj6SumG1h94DcWeCtNqQzo8UNBw0r6-bBDH-bHF-1TXNkXFxdY6WmkxwRjghAQs7',
    },
    {
      title: 'Invalid Google link returns undefined',
      url: new URL(
        ' https://drive.google.com/drive/folders/12pw4i_y1obwaFHazs0yrdqwv7wyCBwNR?usp=sharing',
      ),
      expected: undefined,
    },
  ].forEach(({ title, url, expected }) => {
    it(title, () => {
      expect(GoogleDocsService.getFileId(url)).toEqual(expected);
    });
  });
});

describe('isSupportedUrl', () => {
  [
    {
      title: 'Docsend',
      url: 'https://docsend.com/view/2x4h6j6hgvykz9qa',
      expected: true,
    },
    {
      title: 'Docsend with company subdomain',
      url: 'https://hello.docsend.com/view/2x4h6j6hgvykz9qa',
      expected: true,
    },
    {
      title: 'Docsend with /s in the pathname',
      url: 'https://hello.docsend.com/view/s/2x4h6j6hgvykz9qa',
      expected: true,
    },
    {
      title: 'Google docs',
      url: 'https://docs.google.com/presentation/d/1nxGuAYYo_v_bdOe2KztphWtIwNMK-lTs-8r2fq4FXno/edit#slide=id.p1',
      expected: true,
    },
    {
      title: 'Google drive',
      url: 'https://drive.google.com/file/d/1kEMOild5rdErN-7kRqbtPLWqz7KslHLJ/view',
      expected: true,
    },
    {
      title: 'Pitch.com',
      url: 'https://pitch.com/v/tinyvc-ds46s6',
      expected: true,
    },
    {
      title: 'PDF',
      url: 'https://example.com/dummy.pdf?foo=bar',
      expected: true,
    },
    {
      title: 'Canva viewer link',
      url: 'https://www.canva.com/design/DAHQQMXTewE/9JrvlveKYON_Z_cG6T5p7w/view',
      expected: true,
    },
    {
      title: 'Canva editor link',
      url: 'https://www.canva.com/design/DAHQQMXTewE/9JrvlveKYON_Z_cG6T5p7w/edit',
      expected: true,
    },
    {
      title: 'Canva editor link with tracking parameters',
      url: 'https://www.canva.com/design/DAHQQMXTewE/9JrvlveKYON_Z_cG6T5p7w/edit?utm_content=DAHQQMXTewE&utm_campaign=designshare',
      expected: true,
    },
    {
      title: 'Canva homepage',
      url: 'https://www.canva.com/',
      expected: false,
    },
    {
      title: 'Unsupported',
      url: 'https://google.com/view/thing',
      expected: false,
    },
    {
      title: 'Empty',
      url: '',
      expected: false,
    },
  ].forEach(({ title, url, expected }) => {
    it(title, () => {
      expect(DocumentSourceService.isSupportedUrl(url)).toEqual(expected);
    });
  });
});

describe('sanitizeUrl', () => {
  [
    {
      title: 'Canva editor link is rewritten to the viewer route',
      url: 'https://www.canva.com/design/DAHQQMXTewE/9JrvlveKYON_Z_cG6T5p7w/edit',
      expected: 'https://www.canva.com/design/DAHQQMXTewE/9JrvlveKYON_Z_cG6T5p7w/view',
    },
    {
      title: 'Canva editor link keeps its query and hash',
      url: 'https://www.canva.com/design/DAHQQMXTewE/9JrvlveKYON_Z_cG6T5p7w/edit?utm_campaign=designshare#3',
      expected:
        'https://www.canva.com/design/DAHQQMXTewE/9JrvlveKYON_Z_cG6T5p7w/view?utm_campaign=designshare#3',
    },
    {
      title: 'Canva viewer link is left alone',
      url: 'https://www.canva.com/design/DAHQQMXTewE/9JrvlveKYON_Z_cG6T5p7w/view#1',
      expected: 'https://www.canva.com/design/DAHQQMXTewE/9JrvlveKYON_Z_cG6T5p7w/view#1',
    },
    {
      title: 'a non-Canva /edit link is left alone',
      url: 'https://docs.google.com/presentation/d/13Z8ENq-uvaFzKx99yTDp8DfcDqC8sTy35-yH0XlVQ1I/edit',
      expected:
        'https://docs.google.com/presentation/d/13Z8ENq-uvaFzKx99yTDp8DfcDqC8sTy35-yH0XlVQ1I/edit',
    },
  ].forEach(({ title, url, expected }) => {
    it(title, () => {
      expect(DocumentSourceService.sanitizeUrl(url)).toEqual(expected);
    });
  });
});

describe('NOTION_REGEX', () => {
  it.each([
    'https://www.notion.so/Deck-abc123',
    'https://notion.so/Deck-abc123',
    'https://acme.notion.site/Deck-abc123',
    'https://app.notion.com/p/Deck-abc123',
  ])('accepts %s', (url) => {
    expect(NOTION_REGEX.test(url)).toBe(true);
  });

  it.each([
    'https://evil.notion.com/p/abc',
    'https://notion.com/p/abc',
    'http://app.notion.com/p/abc',
    'https://app.notion.com',
  ])('rejects %s', (url) => {
    expect(NOTION_REGEX.test(url)).toBe(false);
  });
});
