/** Strip connection strings from messages before they are printed. */
export function redactSecrets(text: string): string {
  return text
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://***")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//***:***@");
}
