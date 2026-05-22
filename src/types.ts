/**
 * Cross-cutting shared types. Module-specific types stay in their own files.
 */

/** Token type for the Railway API. */
export type TokenType = 'bearer' | 'project';

/** Registry credentials for private image pulls. Pass-by-value to keep tests pure. */
export interface RegistryCredentials {
  username: string;
  password: string;
}
