// The walk contract, proved on the smallest adapter there is.
//
// Email is the minimal instance: a root whose only edge is the one an arrival
// is pushed along, and one hop from there to the attachments. That makes it the
// right place to pin what `edgesFrom` PROMISES, rather than what it happens to
// return for a bigger adapter.

import { EmailAdapter, EMAIL_RECORD_TYPE_ID, EMAIL_ATTACHMENT_TYPE_ID, EMAIL_ATTACHMENTS_FIELD } from '../index';
import { META_RECORD_TYPE, makeUnstablePosition } from 'movement-engine/services/translation_graph/types';

const adapter = () => new EmailAdapter({ teamId: 'team-1' } as never);

const at = (recordType: string) =>
  makeUnstablePosition({ adapterType: 'email', recordType, data: {} });

describe('email edgesFrom — the walk', () => {
  it('the root offers exactly one edge, and it is a FIRES edge, not a read', async () => {
    const result = await adapter().edgesFrom(at(META_RECORD_TYPE));
    expect(result).not.toBeNull();
    const refs = result!.descriptor.references;
    expect(refs).toHaveLength(1);
    const [edge] = refs;
    expect(edge.name).toBe('Email');
    // The honest shape of an inbox: you cannot list it, so the edge that
    // reaches an email is one you are PUSHED along.
    expect(edge.fires).toBe(true);
    expect(edge.readable).toBe(false);
  });

  it('a root with no readable edge is a real answer, not an empty one', async () => {
    const result = await adapter().edgesFrom(at(META_RECORD_TYPE));
    const readable = result!.descriptor.references.filter((r) => r.readable !== false);
    expect(readable).toHaveLength(0);
    // ...but the node still describes itself, so an agent reads "entered by
    // being pushed into" rather than "this system is empty".
    expect(result!.descriptor.description).toMatch(/not enumerable|arriv/i);
  });

  it('the edge carries what it LANDS ON — an agent can write without walking', async () => {
    const result = await adapter().edgesFrom(at(META_RECORD_TYPE));
    const target = result!.targetNodes?.[EMAIL_RECORD_TYPE_ID];
    expect(target).toBeDefined();
    // Email's describes are local, so it hydrates rather than stubbing — an
    // adapter stubs when a fetch is expensive, and email's costs nothing.
    expect(target!.stub).toBeUndefined();
    // The whole point: the landing's fields are in hand at the root.
    const fields = (target as { fields: { displayName: string }[] }).fields.map((f) => f.displayName);
    expect(fields).toEqual(expect.arrayContaining(['Subject', 'From', 'Body']));
  });

  it('but NOT the target\'s onward edges — that is the one thing withheld', async () => {
    const result = await adapter().edgesFrom(at(META_RECORD_TYPE));
    const target = result!.targetNodes?.[EMAIL_RECORD_TYPE_ID];
    // `Email` genuinely HAS an onward edge (Attachments); the lookahead stops
    // here deliberately, which is what makes exploring cost one hop.
    expect(target).not.toHaveProperty('references');
  });

  it('one hop on, the withheld edge is there — keyed the same way', async () => {
    const result = await adapter().edgesFrom(at(EMAIL_RECORD_TYPE_ID));
    const edge = result!.descriptor.references.find((r) => r.fieldId === EMAIL_ATTACHMENTS_FIELD);
    expect(edge?.name).toBe('Attachments');
    // `targetPositions` says how to get there; `targetNodes` says what is
    // there. Same key, so a caller never has to correlate two vocabularies.
    const target = result!.targetNodes?.[EMAIL_ATTACHMENTS_FIELD];
    expect(target?.displayName).toBe('Attachment');
    expect(target).not.toHaveProperty('references');
  });

  it('every edge hands over the PATH to follow it — a caller echoes, never constructs', async () => {
    // The walk's currency. Without a path the edge is visible but unfollowable,
    // and the caller falls back to naming the type — which for a container-
    // shaped adapter is the workspace fanout this whole model exists to kill.
    const root = await adapter().edgesFrom(at(META_RECORD_TYPE));
    expect(root!.targetPositions?.[EMAIL_RECORD_TYPE_ID]?.recordType).toBe(EMAIL_RECORD_TYPE_ID);

    const email = await adapter().edgesFrom(at(EMAIL_RECORD_TYPE_ID));
    expect(email!.targetPositions?.[EMAIL_ATTACHMENTS_FIELD]?.recordType).toBe(EMAIL_ATTACHMENT_TYPE_ID);
  });

  it('a leaf says it has no edges — which is not the same as withholding them', async () => {
    const result = await adapter().edgesFrom(at(EMAIL_ATTACHMENT_TYPE_ID));
    // An EMPTY references array is a true statement about the attachment.
    // An ABSENT target node means "we did not tell you". The distinction is
    // why the target type omits `references` rather than emptying it.
    expect(result!.descriptor.references).toEqual([]);
    expect(result!.targetNodes).toBeUndefined();
  });

  it('edgesFrom(T) agrees with describe(T) about the node itself', async () => {
    // The collapse the contract is heading for: one shape for "what is this
    // type", so a caller falling back to describe sees the same facts.
    const a = adapter();
    const walked = await a.edgesFrom(at(EMAIL_RECORD_TYPE_ID));
    const described = await a.describe(EMAIL_RECORD_TYPE_ID);
    expect(walked!.descriptor).toEqual(described);
  });
});
