/**
 * An error that explains itself to the user, such as a model that isn't in the catalog or a drive
 * that's full, rather than a bug. The orchestrator shows these as they are.
 */
export class ModelsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
