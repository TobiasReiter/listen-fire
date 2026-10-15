// Source: https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/keyvault/keyvault-certificates/src/certificatesModels.ts#L816
type AtLeastOne<T> = {
  [K in keyof T]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<keyof T, K>>>;
}[keyof T];

export { AtLeastOne };

/** A value read as a string-keyed record: any object that is not `null` or an
 *  array (its prototype is not looked at; engine-contracts' `isPlainObject`
 *  also asks for a plain one). */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
