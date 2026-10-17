// Files a module reads out, named as files the INSTANCE owns. A module names
// a file it reads by its own handle (`{ ownerAdapterType, handle }`, the
// wire's spelling): it cannot name its install, which is the host's. The host
// rewrites each file at a field the module's catalog declares a file (and each
// resource's file) to name the owning instance — its type and credential — so
// the engine can resolve that instance again and redeem the handle through
// `resolveFileRef`. The remote adapter does this for a module served as a
// process; `ownedFilesAdapter` does the same for one loaded in process.

import type { Adapter, GetFieldValueInput, RelatedResult } from '../adapter';
import type { SchemaTypeDescriptor } from '../types';

import { fileDescriptorOf, ownedFileSource, RESOURCES_REFERENCE_FIELD_ID } from '../adapter';

/** The instance a module's files are named as owned by. */
export interface FileOwnerInstance {
  adapterType: string;
  credentialsId?: string;
  /** The install's construction arguments (an entry position), which
   *  constructing the owner again needs. */
  constructionArgs?: Record<string, string>;
}

/** The handle a file's `source` carries, in either spelling. */
function sourceHandle(source: unknown): string | undefined {
  if (source === null || typeof source !== 'object' || !('handle' in source)) return undefined;
  return typeof source.handle === 'string' ? source.handle : undefined;
}

/**
 * The rewrite, over the module's own catalog (asked once per type; a failure
 * is the call's, never remembered).
 */
export class FileOwnership {
  private readonly described = new Map<string, Promise<SchemaTypeDescriptor | null>>();

  constructor(
    private readonly owner: FileOwnerInstance,
    private readonly options: {
      describe: (typeRef: string) => Promise<SchemaTypeDescriptor | null>;
      /** The catalog could not be read, so whether the answer is a file is not
       *  known: the read fails with this rather than taking it for data. */
      describeFailed: (recordType: string, fieldId: string, error: unknown) => Error;
    },
  ) {}

  /** A `getFieldValue` answer, its files named as this instance's. */
  async fieldValue(input: Pick<GetFieldValueInput, 'position' | 'fieldId'>, value: unknown): Promise<unknown> {
    // A scalar is no file whatever the catalog says: no need to ask it.
    if (value === null || typeof value !== 'object') return value;
    const field = await this.declaredField(input.position.recordType, input.fieldId);
    if (field?.kind !== 'file') return value;
    return Array.isArray(value) ? value.map((member) => this.ownedFile(member)) : this.ownedFile(value);
  }

  /** A `getRelated` answer: a resource's `fileRef` slot (typed — whatever it
   *  holds is that resource's file) named as this instance's. */
  related(fieldId: string, related: RelatedResult[]): RelatedResult[] {
    return fieldId === RESOURCES_REFERENCE_FIELD_ID ? related.map((r) => this.ownedResource(r)) : related;
  }

  /** The field a read names, as the catalog declares it on the position's
   *  type — by its natural name or its id. */
  private async declaredField(recordType: string | null, fieldId: string): Promise<SchemaTypeDescriptor['fields'][number] | undefined> {
    if (recordType === null) return undefined;
    let descriptor = this.described.get(recordType);
    if (descriptor === undefined) {
      const asked = this.options.describe(recordType);
      descriptor = asked;
      this.described.set(recordType, asked);
      asked.catch(() => {
        if (this.described.get(recordType) === asked) this.described.delete(recordType);
      });
    }
    let described: SchemaTypeDescriptor | null;
    try {
      described = await descriptor;
    } catch (error) {
      throw this.options.describeFailed(recordType, fieldId, error);
    }
    return described?.fields.find((field) => field.displayName === fieldId || field.fieldId === fieldId);
  }

  /**
   * One file, named as this instance's: by its handle, or — a file that
   * arrives with only a `url` — by that url (`resolveFileRef` sends it back,
   * and the kit answers with the ref's url). A value that spells no
   * descriptor stays as it came.
   */
  ownedFile(value: unknown): unknown {
    const ref = fileDescriptorOf(value);
    if (ref === undefined) return value;
    const { source, ...rest } = ref;
    const handle = sourceHandle(source) ?? (typeof rest.url === 'string' ? rest.url : undefined);
    return handle === undefined
      ? rest
      : {
          ...rest,
          source: ownedFileSource({
            adapterType: this.owner.adapterType,
            credentialsId: this.owner.credentialsId,
            ...(this.owner.constructionArgs !== undefined ? { constructionArgs: this.owner.constructionArgs } : {}),
            handle,
          }),
        };
  }

  private ownedResource(related: RelatedResult): RelatedResult {
    const identity = related.position.identity;
    const data: unknown = identity.data;
    if (typeof data !== 'object' || data === null || !('fileRef' in data) || data.fileRef === undefined) return related;
    const owned = { ...data, fileRef: this.ownedFile(data.fileRef) };
    return { ...related, position: { ...related.position, identity: { ...identity, data: owned } } };
  }
}

/** The catalog of an in-process module could not be read for a field it
 *  answered (the in-process twin of the remote adapter's refusal). */
export class OwnedFileDescribeFailed extends Error {
  constructor(adapterType: string, recordType: string, fieldId: string, cause: unknown) {
    super(
      `Adapter "${adapterType}": describe(${JSON.stringify(recordType)}) failed, so whether ${JSON.stringify(fieldId)} holds a file is not known — ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'OwnedFileDescribeFailed';
  }
}

/**
 * An in-process module's adapter whose files name `owner`: `getFieldValue`
 * and `getRelated` answers rewritten as the remote adapter rewrites them.
 * Every other member is the adapter's own, so a member it lacks stays absent.
 */
export function ownedFilesAdapter<A extends Adapter>(adapter: A, owner: FileOwnerInstance): A {
  const ownership = new FileOwnership(owner, {
    describe: (typeRef) => adapter.describe(typeRef),
    describeFailed: (recordType, fieldId, error) => new OwnedFileDescribeFailed(owner.adapterType, recordType, fieldId, error),
  });
  return new Proxy(adapter, {
    get(target, key, receiver) {
      if (key === 'getFieldValue') {
        return async (input: GetFieldValueInput) => ownership.fieldValue(input, await target.getFieldValue(input));
      }
      if (key === 'getRelated') {
        return async (input: Parameters<Adapter['getRelated']>[0]) => ownership.related(input.fieldId, await target.getRelated(input));
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
