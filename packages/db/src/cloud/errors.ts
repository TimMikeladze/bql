export class CloudError extends Error {
  constructor(readonly code: string, message: string, readonly requestId?: string) { super(message); this.name = "CloudError" }
}
