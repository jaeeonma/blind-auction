// Loads .env from the repository root (secrets such as the DB password live there, never in Git).
// Node's built-in loader is used instead of a dotenv dependency. Variables already set in the
// environment win, so CI or tests can override them.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // No .env file: rely on the process environment.
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}
