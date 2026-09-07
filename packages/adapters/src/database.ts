import { SQL } from "bun";

/** Creates the single PostgreSQL connection pool used by one application process. */
export const createDatabase = (url: string): SQL => new SQL(url);

export const closeDatabase = async (database: SQL): Promise<void> => { await database.close(); };
