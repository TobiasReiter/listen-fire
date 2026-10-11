// The host's refusal of a byte read that is not the run's team's
// (`streamFileRef`). Its own module, so whatever reads files can name it
// without loading the reader.

/**
 * A file whose bytes are not the team's to read: a stored document the team
 * does not own, or an owning adapter instance the run does not hold.
 * The host's own named error — the read never happens, and nothing is
 * answered in its place.
 */
export class FileOutsideTeamError extends Error {
  readonly code = 'FILE_OUTSIDE_TEAM';

  constructor(
    readonly owner: 'document' | 'instance',
    readonly named: string,
  ) {
    super(
      owner === 'document'
        ? `the file names the stored document ${named}, which is not this team's, so its bytes are not read`
        : `the file names an instance of ${named}, which this run does not hold, so its bytes are not read`,
    );
    this.name = 'FileOutsideTeamError';
  }
}
