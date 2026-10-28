// Mimics the base declarations of @clevercloud/client
export declare abstract class CcApiSimpleCommand<Input, Output> {
  protected readonly params: Input;
  protected readonly output: Output;
}
export declare abstract class CcApiStreamCommand<Input, Output> {
  protected readonly params: Input;
  protected readonly output: Output;
}
export type MaybeWithOwnerId<T> = T & { ownerId?: string };
export type ApplicationId = MaybeWithOwnerId<{ applicationId: string }>;
export type AddonId = MaybeWithOwnerId<{ addonId: string }>;
