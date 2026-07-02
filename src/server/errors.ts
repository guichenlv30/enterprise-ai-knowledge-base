export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function assertFound<T>(value: T | undefined | null, message = "资源不存在"): T {
  if (!value) throw new HttpError(404, message);
  return value;
}
