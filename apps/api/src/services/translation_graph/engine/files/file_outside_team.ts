// The host's refusal of a byte read that is not the run's team's
// (`streamFileRef`). Its own module, so whatever reads files can name it
// without loading the reader.

/**
 * A file whose bytes are not the team's to read: a stored document the team
 * does not own, an owning adapter instance the run does not hold (or holds
 * more than one of, with nothing to choose between them), or a URL handle its
 * owner did not issue.
 * The host's own named error — the read never happens, and nothing is
 * answered in its place.
 */
export class FileOutsideTeamError extends Error {
  readonly code = 'FILE_OUTSIDE_TEAM';

  constructor(
    readonly owner: 'document' | 'instance' | 'handle',
    readonly named: string,
  ) {
    super(
      owner === 'document'
        ? `the file names the stored document ${named}, which is not this team's, so its bytes are not read`
        : owner === 'instance'
          ? `the file names an instance of ${named}, which this run does not hold (or holds more than one of: a descriptor in the earlier spelling, naming no credential, needs one), so its bytes are not read`
          : `the file's handle is not one its owner ${named} issued, so it is not fetched`,
    );
    this.name = 'FileOutsideTeamError';
  }
}
