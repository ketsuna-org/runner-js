import './bun-compat.js';
import type { DatabaseConfig } from '../config/js-bot-config.js';
import pg from 'pg';
import mysql from 'mysql2/promise';
import type { MongoClient, Db, Collection } from 'mongodb';

export interface PgsqlInterface {
  query(text: string, params?: unknown[]): Promise<pg.QueryResult>;
  connect(): Promise<pg.PoolClient>;
  pool: pg.Pool;
}

export interface SqlInterface {
  query(sql: string, values?: unknown): Promise<[mysql.QueryResult, mysql.FieldPacket[]]>;
  execute(sql: string, values?: unknown): Promise<[mysql.QueryResult, mysql.FieldPacket[]]>;
  getConnection(): Promise<mysql.PoolConnection>;
  pool: mysql.Pool;
}

export interface MongoInterface {
  db(name?: string): Db;
  collection<T extends import('mongodb').Document = import('mongodb').Document>(name: string): Collection<T>;
  client: MongoClient;
}

export interface DatabaseHandles {
  pgsql?: PgsqlInterface;
  sql?: SqlInterface;
  mongo?: MongoInterface;
}

export class DatabaseManager {
  #config: DatabaseConfig;
  #pgPool: pg.Pool | null = null;
  #mysqlPool: mysql.Pool | null = null;
  #mongoClient: MongoClient | null = null;
  #handles: DatabaseHandles = {};

  constructor(config: DatabaseConfig) {
    this.#config = config;
    this.init();
  }

  private init(): void {
    const dbType = this.#config.type;
    if (!dbType || dbType === 'none') {
      return;
    }

    if (dbType === 'postgres') {
      const uri = this.#config.uri?.trim();
      const ssl = this.#config.ssl ? { rejectUnauthorized: false } : undefined;
      const pool = uri
        ? new pg.Pool({ connectionString: uri, ssl })
        : new pg.Pool({
            host: this.#config.host?.trim() || 'localhost',
            port: this.#config.port ? Number(this.#config.port) : 5432,
            database: this.#config.database?.trim(),
            user: this.#config.user?.trim(),
            password: this.#config.password,
            ssl,
          });

      pool.on('error', (err) => {
        console.warn('[DatabaseManager:pg] Pool error:', err.message);
      });

      this.#pgPool = pool;
      this.#handles.pgsql = {
        query: (text, params) => pool.query(text, params),
        connect: () => pool.connect(),
        pool,
      };
    } else if (dbType === 'mysql') {
      const uri = this.#config.uri?.trim();
      const pool = uri
        ? mysql.createPool(uri)
        : mysql.createPool({
            host: this.#config.host?.trim() || 'localhost',
            port: this.#config.port ? Number(this.#config.port) : 3306,
            database: this.#config.database?.trim(),
            user: this.#config.user?.trim(),
            password: this.#config.password,
            ssl: this.#config.ssl ? {} : undefined,
            waitForConnections: true,
            connectionLimit: 10,
          });

      this.#mysqlPool = pool;
      this.#handles.sql = {
        query: (sqlText, values) => pool.query(sqlText, values as never),
        execute: (sqlText, values) => pool.execute(sqlText, values as never),
        getConnection: () => pool.getConnection(),
        pool,
      };
    } else if (dbType === 'mongo') {
      const { MongoClient } = require('mongodb') as typeof import('mongodb');
      const uri = this.#config.uri?.trim() || this.buildMongoUri();
      const client = new MongoClient(uri);

      this.#mongoClient = client;
      const defaultDb = this.#config.database?.trim() || undefined;

      this.#handles.mongo = {
        db: (name?: string) => client.db(name || defaultDb),
        collection: (name: string) => client.db(defaultDb).collection(name),
        client,
      };
    }
  }

  private buildMongoUri(): string {
    const host = this.#config.host?.trim() || 'localhost';
    const port = this.#config.port ? Number(this.#config.port) : 27017;
    const db = this.#config.database?.trim() || '';
    const user = this.#config.user?.trim();
    const pass = this.#config.password;

    if (user && pass) {
      return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
    }
    return `mongodb://${host}:${port}/${db}`;
  }

  get handles(): DatabaseHandles {
    return this.#handles;
  }

  async dispose(): Promise<void> {
    if (this.#pgPool) {
      try {
        await this.#pgPool.end();
      } catch {
        // ignore on shutdown
      }
      this.#pgPool = null;
    }

    if (this.#mysqlPool) {
      try {
        await this.#mysqlPool.end();
      } catch {
        // ignore on shutdown
      }
      this.#mysqlPool = null;
    }

    if (this.#mongoClient) {
      try {
        await this.#mongoClient.close();
      } catch {
        // ignore on shutdown
      }
      this.#mongoClient = null;
    }

    this.#handles = {};
  }
}
