// Attio Note / Task / Comment creates — the metadata-type half of
// createRecord (POST /v2/notes, /v2/tasks, /v2/comments), wired 2026-07-04
// after the schema published these types writable while the create threw
// "not yet implemented". Drives the REAL createRecord dispatch with the API
// client and the resolver-backed private helpers stubbed, pinning:
//   - the exact request each create sends (parent → parent_object /
//     linked_records / record target),
//   - the required-field guards (blank content/title/author reject before
//     any API call),
//   - comment author resolution (email → workspace member; unknown → error),
//   - comment thread_id routing (reply vs new-thread-on-record),
//   - the legacy generic list-entry type staying UNWRITABLE.


import type { FileRef } from '../../adapter';
import type { MutationContext } from '../../mutation_context';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import {
  createAttioAdapter,
  ATTIO_NOTE_TYPE_ID,
  ATTIO_TASK_TYPE_ID,
  ATTIO_COMMENT_TYPE_ID,
  ATTIO_LIST_ENTRY_TYPE_ID,
  ATTIO_LIST_TYPE_ID,
  ATTIO_LIST_MEMBERSHIP_PREFIX,
  ATTIO_FILE_TYPE_ID,
} from '../attio';
import { installMemoryDocumentStore } from '../../engine/files/__test__/memory_document_store';

const mutationContext: MutationContext = {
  source: { type: 'structured_input' },
  occurredAt: new Date('2026-07-04T00:00:00Z').toISOString(),
};

const createNote = jest.fn();
const createTask = jest.fn();
const createComment = jest.fn();
const createListEntry = jest.fn();
const listWorkspaceMembers = jest.fn();
const uploadFile = jest.fn();

function testAdapter() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = createAttioAdapter({
    teamId: 'team-1' as TeamId,
    credentialsId: 'cred-1',
  }) as any;
  // Stub the credentialed/introspective seams; everything between the
  // createRecord entry point and the client call runs for real.
  adapter.getApiClient = async () => ({
    createNote,
    createTask,
    createComment,
    createListEntry,
    listWorkspaceMembers,
    uploadFile,
  });
  adapter.toInternalWrite = async (input: unknown) => input; // names already internal below
  adapter.structuredListFor = async () => null; // not a per-list write
  adapter.resolveObjectSlugFromRecordType = async (recordType: string) =>
    recordType === 'attio:companies' ? 'companies' : null;
  return adapter;
}

beforeEach(() => {
  jest.clearAllMocks();
  createNote.mockResolvedValue({ id: { workspace_id: 'w', note_id: 'note-1' } });
  createTask.mockResolvedValue({ id: { workspace_id: 'w', task_id: 'task-1' } });
  createComment.mockResolvedValue({
    id: { workspace_id: 'w', comment_id: 'comment-1' },
    thread_id: 'thread-9',
    content_plaintext: 'hello',
    created_at: '2026-07-04T00:00:00Z',
  });
  createListEntry.mockResolvedValue({ entryId: 'entry-1' });
  listWorkspaceMembers.mockResolvedValue([
    { id: 'member-1', firstName: 'Ada', lastName: 'O', email: 'ada@example.com' },
  ]);
});

const companyParent = { recordType: 'attio:companies', externalId: 'rec-1', edgeName: 'Notes' };

describe('note create', () => {
  it('POSTs the parent record + title + content and returns the note id', async () => {
    const result = await testAdapter().createRecord({
      recordType: ATTIO_NOTE_TYPE_ID,
      fields: { title: 'Call notes', content_plaintext: 'Spoke to Jane.' },
      parentLinks: [companyParent],
      mutationContext,
    });
    expect(createNote).toHaveBeenCalledWith({
      parentObject: 'companies',
      parentRecordId: 'rec-1',
      title: 'Call notes',
      content: 'Spoke to Jane.',
      format: 'plaintext',
    });
    expect(result.externalId).toBe('note-1');
  });

  it('rejects a note with no parent record before calling the API', async () => {
    await expect(
      testAdapter().createRecord({
        recordType: ATTIO_NOTE_TYPE_ID,
        fields: { title: 't', content_plaintext: 'c' },
        mutationContext,
      }),
    ).rejects.toThrow(/child of a record action/);
    expect(createNote).not.toHaveBeenCalled();
  });

  it('rejects blank required fields before calling the API', async () => {
    await expect(
      testAdapter().createRecord({
        recordType: ATTIO_NOTE_TYPE_ID,
        fields: { title: '  ', content_plaintext: 'c' },
        parentLinks: [companyParent],
        mutationContext,
      }),
    ).rejects.toThrow(/"title" is required/);
    expect(createNote).not.toHaveBeenCalled();
  });
});

describe('task create', () => {
  it('links every parent record and passes the deadline through', async () => {
    const result = await testAdapter().createRecord({
      recordType: ATTIO_TASK_TYPE_ID,
      fields: { content_plaintext: 'Follow up', deadline_at: '2026-07-10T09:00:00Z' },
      parentLinks: [{ ...companyParent, edgeName: 'Tasks' }],
      mutationContext,
    });
    expect(createTask).toHaveBeenCalledWith({
      content: 'Follow up',
      assignees: [],
      linkedRecords: [{ targetObject: 'companies', targetRecordId: 'rec-1' }],
      deadlineAt: '2026-07-10T09:00:00Z',
    });
    expect(result.externalId).toBe('task-1');
  });

  it('a parentless task is valid (Attio tasks may link zero records)', async () => {
    await testAdapter().createRecord({
      recordType: ATTIO_TASK_TYPE_ID,
      fields: { content_plaintext: 'Standalone' },
      mutationContext,
    });
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ linkedRecords: [], deadlineAt: null }),
    );
  });
});

describe('comment create', () => {
  it('resolves the author email to a workspace member and targets the parent record', async () => {
    const result = await testAdapter().createRecord({
      recordType: ATTIO_COMMENT_TYPE_ID,
      fields: { content_plaintext: 'hello', author: 'Ada@Example.com' },
      parentLinks: [{ ...companyParent, edgeName: 'Comments' }],
      mutationContext,
    });
    expect(createComment).toHaveBeenCalledWith({
      content: 'hello',
      authorWorkspaceMemberId: 'member-1',
      record: { object: 'companies', recordId: 'rec-1' },
    });
    expect(result.externalId).toBe('comment-1');
    expect(result.data.thread_id).toBe('thread-9');
  });

  it('an explicit thread_id replies into the thread instead of the record', async () => {
    await testAdapter().createRecord({
      recordType: ATTIO_COMMENT_TYPE_ID,
      fields: { content_plaintext: 'reply', author: 'ada@example.com', thread_id: 'thread-42' },
      mutationContext,
    });
    expect(createComment).toHaveBeenCalledWith({
      content: 'reply',
      authorWorkspaceMemberId: 'member-1',
      threadId: 'thread-42',
    });
  });

  it('rejects an author email that matches no workspace member', async () => {
    await expect(
      testAdapter().createRecord({
        recordType: ATTIO_COMMENT_TYPE_ID,
        fields: { content_plaintext: 'x', author: 'stranger@example.com' },
        parentLinks: [{ ...companyParent, edgeName: 'Comments' }],
        mutationContext,
      }),
    ).rejects.toThrow(/does not match any Attio workspace member/);
    expect(createComment).not.toHaveBeenCalled();
  });
});

describe('legacy generic list entry', () => {
  it('stays unwritable with a pointer at the per-list types', async () => {
    await expect(
      testAdapter().createRecord({
        recordType: ATTIO_LIST_ENTRY_TYPE_ID,
        fields: {},
        parentLinks: [companyParent],
        mutationContext,
      }),
    ).rejects.toThrow(/not writable — write to the specific list's own entry type/);
  });
});

describe('list membership create (`write <record>-[:Lists]-> { list: "…", … }`)', () => {
  // The write target type is the generic `List` (ATTIO_LIST_TYPE_ID) — the
  // `Lists` edge's target; the specific list is named in the body. The record
  // (the write's subject) is the parent; `createPerListEntry` attaches it.
  function listWriteAdapter() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = testAdapter() as any;
    adapter.structuredListFor = async (name: string) =>
      name === 'VC Deal Flow' ? { id: 'list-9', name: 'VC Deal Flow' } : null;
    adapter.resolveObjectIdFromRecordType = async () => 'obj-companies';
    adapter.resolver = async () => ({
      // Entry-value keys arrive display-named (the generic List type has no
      // attribute map, so toInternalWrite left them alone); re-resolve them
      // against the RESOLVED list's attributes.
      tryFieldId: (_type: string, field: string) =>
        field === 'Deal Stage' ? 'deal_stage' : undefined,
    });
    return adapter;
  }

  const companyLink = { recordType: 'attio:companies', externalId: 'rec-7', edgeName: 'Lists' };

  it('resolves the named list and attaches the parent record (membership)', async () => {
    const result = await listWriteAdapter().createRecord({
      recordType: ATTIO_LIST_TYPE_ID,
      fields: { listName: 'VC Deal Flow' },
      parentLinks: [companyLink],
      mutationContext,
    });
    expect(createListEntry).toHaveBeenCalledWith({
      listId: 'list-9',
      parentObjectId: 'obj-companies',
      parentRecordId: 'rec-7',
      entryValues: {},
    });
    expect(result.externalId).toBe('entry-1');
  });

  it('routes a per-object membership type (the real edge target) to the same handler', async () => {
    // In production the `Lists` edge targets each object's OWN membership type
    // (`attio:list-membership:<slug>`), not the generic `List` — so the create
    // arrives with that recordType. It routes to the same handler.
    const result = await listWriteAdapter().createRecord({
      recordType: `${ATTIO_LIST_MEMBERSHIP_PREFIX}companies`,
      fields: { listName: 'VC Deal Flow' },
      parentLinks: [companyLink],
      mutationContext,
    });
    expect(createListEntry).toHaveBeenCalledWith(
      expect.objectContaining({ listId: 'list-9', parentRecordId: 'rec-7' }),
    );
    expect(result.externalId).toBe('entry-1');
  });

  it('re-keys any entry values that arrive against the resolved list', async () => {
    // The generic `List` write shape is CLOSED to `listName`, so the checker
    // rejects extra fields; but if one arrives (a non-checked path), it is
    // re-resolved against the RESOLVED list's attributes, never dropped.
    await listWriteAdapter().createRecord({
      recordType: ATTIO_LIST_TYPE_ID,
      fields: { listName: 'VC Deal Flow', 'Deal Stage': 'Contacted' },
      parentLinks: [companyLink],
      mutationContext,
    });
    expect(createListEntry).toHaveBeenCalledWith(
      expect.objectContaining({ listId: 'list-9', entryValues: { deal_stage: 'Contacted' } }),
    );
  });

  it('rejects when the list is not named in the body before any API call', async () => {
    await expect(
      listWriteAdapter().createRecord({
        recordType: ATTIO_LIST_TYPE_ID,
        fields: {},
        parentLinks: [companyLink],
        mutationContext,
      }),
    ).rejects.toThrow(/needs the list named/);
    expect(createListEntry).not.toHaveBeenCalled();
  });

  it('rejects an unknown list name before any API call', async () => {
    await expect(
      listWriteAdapter().createRecord({
        recordType: ATTIO_LIST_TYPE_ID,
        fields: { listName: 'Nope' },
        parentLinks: [companyLink],
        mutationContext,
      }),
    ).rejects.toThrow(/no Attio list named "Nope"/);
    expect(createListEntry).not.toHaveBeenCalled();
  });

  it('rejects a list write with no parent record (the record is the parent)', async () => {
    await expect(
      listWriteAdapter().createRecord({
        recordType: ATTIO_LIST_TYPE_ID,
        fields: { listName: 'VC Deal Flow' },
        parentLinks: [],
        mutationContext,
      }),
    ).rejects.toThrow(/child of a record action/);
    expect(createListEntry).not.toHaveBeenCalled();
  });
});

describe('file create (`write record-[:files]->` — upload against the parent record)', () => {
  const store = installMemoryDocumentStore();
  function voiceRef(): FileRef {
    return store.file('OGGBYTES', { name: 'voice.ogg', contentType: 'audio/ogg' });
  }

  beforeEach(() => {
    uploadFile.mockResolvedValue({
      fileId: 'file-1',
      name: 'voice.ogg',
      contentType: 'audio/ogg',
      contentSize: 8,
    });
  });

  it('uploads the File bytes to the parent record and returns the file id', async () => {
    const result = await testAdapter().createRecord({
      recordType: ATTIO_FILE_TYPE_ID,
      fields: { data: voiceRef() },
      parentLinks: [{ recordType: 'attio:companies', externalId: 'rec-1', edgeName: 'Files' }],
      mutationContext,
    });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const call = uploadFile.mock.calls[0][0];
    expect(call).toMatchObject({ objectSlug: 'companies', recordId: 'rec-1', fileName: 'voice.ogg' });
    expect(call.file).toBeInstanceOf(Blob);
    expect(result.externalId).toBe('file-1');
    expect(result.data).toMatchObject({ id: 'file-1', name: 'voice.ogg', contentType: 'audio/ogg' });
  });

  it('rejects a file write whose File field is not a file value', async () => {
    await expect(
      testAdapter().createRecord({
        recordType: ATTIO_FILE_TYPE_ID,
        fields: { data: 'not-a-file' },
        parentLinks: [{ recordType: 'attio:companies', externalId: 'rec-1', edgeName: 'Files' }],
        mutationContext,
      }),
    ).rejects.toThrow(/File/);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('rejects a file write with no parent record', async () => {
    await expect(
      testAdapter().createRecord({
        recordType: ATTIO_FILE_TYPE_ID,
        fields: { data: voiceRef() },
        parentLinks: [],
        mutationContext,
      }),
    ).rejects.toThrow(/child of a record/);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
