// main.ts (Single File Backend using Bun + ElysiaJS)
// Based on your m8.ts (which passed tests), now optimized for Railway.app

// ==============================================================================
// 1. Imports
// ==============================================================================
import { Elysia, t, type Static, NotFoundError, ParseError, ValidationError, InternalServerError } from 'elysia';
import { cors } from '@elysiajs/cors';
import knex, { Knex as KnexInstance } from 'knex';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';

// Debug logging configuration
const DEBUG_LOGGING = process.env.DEBUG_LOGGING !== 'false'; // Enable by default
const LOG_PREFIX = '[Portal]';

// Simple logger that includes timestamp
function cmdLog(message: string, object?: any): void {
  if (!DEBUG_LOGGING) return;
  
  const timestamp = new Date().toISOString();
  const logMsg = `${LOG_PREFIX} ${timestamp} - ${message}`;
  
  if (object !== undefined) {
    console.log(logMsg, typeof object === 'object' ? JSON.stringify(object, null, 2) : object);
  } else {
    console.log(logMsg);
  }
}

// Log startup message
cmdLog('🚀 Server initializing...');

// ==============================================================================
// 2. Configuration - Adapted for Railway.app using Environment Variables
// ==============================================================================

const PORT = parseInt(process.env.PORT || "8000");
const HOST = process.env.HOST || "0.0.0.0"; // Listen on 0.0.0.0 for Railway
const SERVER_TIMEOUT_MS = parseInt(process.env.SERVER_TIMEOUT_MS || "30000"); // Increased from default 10000 to 30000

// --- Database Path Configuration ---
// For Railway, set DATABASE_FILE_PATH to /app/data/portal.db (or your chosen persistent path)
const DATABASE_FILE_PATH_ENV = process.env.DATABASE_FILE_PATH;
let DATABASE_PATH: string;

if (DATABASE_FILE_PATH_ENV) {
    DATABASE_PATH = path.resolve(DATABASE_FILE_PATH_ENV);
    console.log(`[Config] Using DATABASE_FILE_PATH from env: ${DATABASE_PATH}`);
} else {
    // Local development fallback
    const PROJECT_ROOT_LOCAL = import.meta.dirname;
    const DATABASE_RELATIVE_SUBDIR_LOCAL = path.join('main', 'data');
    const DATABASE_DIR_LOCAL = path.resolve(PROJECT_ROOT_LOCAL, DATABASE_RELATIVE_SUBDIR_LOCAL);
    const DATABASE_FILENAME_LOCAL = 'portal.db';
    DATABASE_PATH = path.join(DATABASE_DIR_LOCAL, DATABASE_FILENAME_LOCAL);
    console.log(`[Config] Using local DATABASE_PATH: ${DATABASE_PATH}`);
    // Ensure local directory exists for dev convenience (Railway handles volume creation)
    if (!process.env.RAILWAY_STATIC_URL) { // Simple check if not on Railway-like env
         fs.mkdir(DATABASE_DIR_LOCAL, { recursive: true }).catch(err => {
            if (err.code !== 'EEXIST') console.error("Error creating local DB directory:", err);
         });
    }
}

// --- Uploads Path Configuration ---
// For Railway, set UPLOADS_DIR, e.g., to /app/data/uploads (within your persistent volume)
const UPLOADS_DIR_ENV = process.env.UPLOADS_DIR;
let UPLOAD_DIR: string;

if (UPLOADS_DIR_ENV) {
    UPLOAD_DIR = path.resolve(UPLOADS_DIR_ENV);
    console.log(`[Config] Using UPLOADS_DIR from env: ${UPLOAD_DIR}`);
} else {
    // Local development fallback
    const PROJECT_ROOT_LOCAL = import.meta.dirname;
    const localDbDir = path.dirname(DATABASE_PATH); 
    const UPLOAD_RELATIVE_SUBDIR_LOCAL = path.join(localDbDir, 'uploads');
    UPLOAD_DIR = path.resolve(UPLOAD_RELATIVE_SUBDIR_LOCAL); 
    console.log(`[Config] Using local UPLOAD_DIR: ${UPLOAD_DIR}`);
     if (!process.env.RAILWAY_STATIC_URL) {
        fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(err => {
            if (err.code !== 'EEXIST') console.error("Error creating local Uploads directory:", err);
        });
    }
}

const BILL_UPLOAD_SUBDIR_NAME = "bills";
const BANNER_UPLOAD_SUBDIR_NAME = "banners";
const BILL_UPLOAD_PATH = path.join(UPLOAD_DIR, BILL_UPLOAD_SUBDIR_NAME);
const BANNER_UPLOAD_PATH = path.join(UPLOAD_DIR, BANNER_UPLOAD_SUBDIR_NAME);

const CONFIG_ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const CONFIG_ADMIN_PASSWORD_PLAINTEXT = process.env.ADMIN_PASSWORD || "Goat@2570"; // Default for local ONLY
const DEFAULT_SALESPERSON_ID = 1;

const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || "10");
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const ALLOWED_BILL_EXTENSIONS = new Set(["pdf", "jpg", "jpeg", "png"]);
const ALLOWED_BANNER_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const LOGIN_ATTEMPTS_LIMIT = 3;
const LOGIN_ATTEMPTS_WINDOW_MS = 60 * 60 * 1000;
const ALLOWED_CSV_EXTENSIONS = new Set(["csv", "txt"]);
const STATIC_ASSETS_ROUTE = '/static';

// ==============================================================================
// 3. DB Setup
// ==============================================================================
let dbInstance: KnexInstance;
function getDb(): KnexInstance {
    if (!dbInstance) {
        console.log(`[DB] Initializing Knex for SQLite at: ${DATABASE_PATH}`);
        dbInstance = knex({
            client: 'sqlite3',
            connection: { 
                filename: DATABASE_PATH
            },
            useNullAsDefault: true,
            pool: {
                min: 2,
                max: 10,
                acquireTimeoutMillis: 30000,
                createTimeoutMillis: 30000,
                idleTimeoutMillis: 30000,
                reapIntervalMillis: 1000,
                createRetryIntervalMillis: 100,
                // Configure SQLite connection with optimized settings in afterCreate hook
                afterCreate: (conn: any, done: Function) => {
                    // Execute pragmas in a single transaction to prevent locks
                    conn.exec(`
                        PRAGMA foreign_keys = ON;
                        PRAGMA journal_mode = WAL;
                        PRAGMA busy_timeout = 5000;
                        PRAGMA synchronous = NORMAL;
                        PRAGMA cache_size = 10000;
                        PRAGMA temp_store = MEMORY;
                    `, (err: Error) => {
                        if (err) {
                            console.error('[DB] Failed to set SQLite pragmas in connection:', err);
                        } else {
                            console.log('[DB] SQLite pragmas set successfully for optimized search and reduced locking');
                        }
                        done(err, conn);
                    });
                }
            }
        });
    }
    return dbInstance;
}
async function setupDatabase() { 
    const db = getDb(); 
    console.log(`[DB] Setting up database schema...`); 
    await db.raw('PRAGMA foreign_keys = ON;'); 
    
    if (!(await db.schema.hasTable('salespersons'))) { 
        console.log('[DB] Creating salespersons table...'); 
        await db.schema.createTable('salespersons', (t) => { 
            t.increments('id').primary(); 
            t.string('name').notNullable(); 
            t.string('username').unique().notNullable().index(); 
            t.string('password').notNullable(); 
            t.boolean('is_active').defaultTo(true).notNullable(); 
        }); 
        console.log('[DB] salespersons table created.'); 
        const defaultSalespersonPassword = await Bun.password.hash('password'); 
        await db('salespersons').insert({ id: DEFAULT_SALESPERSON_ID, name: 'Default SalesPerson', username: 'default_sp', password: defaultSalespersonPassword, is_active: true }).onConflict('id').ignore(); 
        console.log('[DB] Ensured Default SalesPerson (ID=1) exists with hashed password.'); 
    } else { 
        console.log('[DB] salespersons table already exists.'); 
    } 
    if (!(await db.schema.hasTable('users'))) { 
        console.log('[DB] Creating users table...'); 
        await db.schema.createTable('users', (t) => { 
            t.increments('id').primary(); 
            t.string('mobile_number').unique().notNullable().index(); 
            t.string('gst_number').unique().nullable().index(); 
            t.string('pan_number').unique().nullable().index(); 
            t.string('company_name').notNullable(); 
            t.boolean('is_active').defaultTo(true).notNullable(); 
            t.boolean('can_register_serials').defaultTo(true).notNullable(); 
            t.text('admin_note').nullable(); 
            t.integer('sales_person_id').unsigned().notNullable().defaultTo(DEFAULT_SALESPERSON_ID); 
            t.foreign('sales_person_id').references('id').inTable('salespersons'); 
            t.check('(`gst_number` IS NOT NULL OR `pan_number` IS NOT NULL)'); 
            t.timestamps(true, true); 
        }); 
        console.log('[DB] users table created.'); 
    } else { 
        console.log('[DB] users table already exists.'); 
    } 
    if (!(await db.schema.hasTable('products'))) { 
        console.log('[DB] Creating products table...'); 
        await db.schema.createTable('products', (t) => { 
            t.increments('id').primary(); 
            t.string('name').notNullable().index(); 
            t.text('description').nullable(); 
        }); 
        console.log('[DB] products table created.'); 
    } else { 
        console.log('[DB] products table already exists.'); 
    } 
    if (!(await db.schema.hasTable('serialnumbers'))) { 
        console.log('[DB] Creating serialnumbers table...'); 
        await db.schema.createTable('serialnumbers', (t) => { 
            t.increments('id').primary(); 
            t.string('serial_number').unique().notNullable().index(); 
            t.integer('product_id').unsigned().notNullable().index(); 
            t.foreign('product_id').references('id').inTable('products').onDelete('CASCADE'); 
            t.integer('user_id').unsigned().nullable().index(); 
            t.foreign('user_id').references('id').inTable('users').onDelete('SET NULL'); 
            t.dateTime('registration_date').nullable(); 
            t.string('bill_filename').nullable(); 
            t.string('status').defaultTo('available').notNullable().index(); 
        }); 
        console.log('[DB] serialnumbers table created.'); 
    } else { 
        console.log('[DB] serialnumbers table already exists.'); 
    } 
    if (!(await db.schema.hasTable('banners'))) { 
        console.log('[DB] Creating banners table...'); 
        await db.schema.createTable('banners', (t) => { 
            t.increments('id').primary(); 
            t.string('image_filename').notNullable(); 
            t.string('link_url').nullable(); 
            t.string('alt_text').nullable(); 
            t.boolean('is_active').defaultTo(true).notNullable().index(); 
            t.dateTime('created_at').defaultTo(db.fn.now()); 
        }); 
        console.log('[DB] banners table created.'); 
    } else { 
        console.log('[DB] banners table already exists.'); 
    } 
    if (!(await db.schema.hasTable('settings'))) { 
        console.log('[DB] Creating settings table...'); 
        await db.schema.createTable('settings', (t) => { 
            t.string('key').primary().notNullable().index(); 
            t.text('value').nullable(); 
        }); 
        console.log('[DB] settings table created.'); 
    } else { 
        console.log('[DB] settings table already exists.'); 
    } 
    if (!(await db.schema.hasTable('audit_logs'))) { 
        console.log('[DB] Creating audit_logs table...'); 
        await db.schema.createTable('audit_logs', (t) => { 
            t.increments('id').primary(); 
            t.dateTime('timestamp').defaultTo(db.fn.now()).index(); 
            t.string('admin_username').nullable().index(); 
            t.string('sales_person_username').nullable().index(); 
            t.string('acting_identifier').nullable().index(); 
            t.string('action').notNullable().index(); 
            t.string('target_type').nullable().index(); 
            t.string('target_id').nullable().index(); 
            t.text('details').nullable(); 
        }); 
        console.log('[DB] audit_logs table created.'); 
    } else { 
        console.log('[DB] audit_logs table already exists.'); 
    } 
    if (!(await db.schema.hasTable('schemes'))) { 
        console.log('[DB] Creating schemes table...'); 
        await db.schema.createTable('schemes', (t) => {
            t.increments('id').primary();
            t.string('name').notNullable().index();
            t.date('start_date').notNullable();
            t.date('end_date').notNullable();
            t.integer('min_products_required').notNullable().defaultTo(1);
            t.boolean('is_active').defaultTo(true).notNullable();
            t.text('description').nullable();
            t.timestamps(true, true);
        });
        console.log('[DB] schemes table created.'); 
    } else { 
        console.log('[DB] schemes table already exists.'); 
    } 
    if (!(await db.schema.hasTable('scheme_products'))) { 
        console.log('[DB] Creating scheme_products table...'); 
        await db.schema.createTable('scheme_products', (t) => {
            t.increments('id').primary();
            t.integer('scheme_id').notNullable()
              .references('id').inTable('schemes').onDelete('CASCADE');
            t.integer('product_id').notNullable()
              .references('id').inTable('products').onDelete('CASCADE');
            t.integer('quantity').notNullable().defaultTo(1);
            t.boolean('is_mandatory').notNullable().defaultTo(false);
            t.boolean('is_excluded').notNullable().defaultTo(false);
            t.timestamps(true, true);
            
            // Composite unique constraint
            t.unique(['scheme_id', 'product_id']);
        }); 
        console.log('[DB] scheme_products table created.'); 
    } else { 
        console.log('[DB] scheme_products table already exists.'); 
    }
    
    console.log("[DB] Database schema setup complete."); }

// ==============================================================================
// 4. Schemas
// ==============================================================================
const MessageSchema=t.Object({message:t.String()}); const SuccessStatusSchema=t.Object({success:t.Boolean(),message:t.Optional(t.String())}); const ExistsCheckSchema=t.Object({exists:t.Boolean()});const PaginationQuerySchema=t.Object({skip:t.Optional(t.Numeric({minimum:0,default:0})),limit:t.Optional(t.Numeric({minimum:1,maximum:100,default:100}))});
const SalesPersonBaseSchema=t.Object({name:t.String({minLength:1}),username:t.String({minLength:3}),is_active:t.Optional(t.Boolean({default:true}))});
const SalesPersonCreateSchema=t.Intersect([SalesPersonBaseSchema,t.Object({password:t.String({minLength:8})})]);
const SalesPersonUpdateSchema=t.Partial(t.Intersect([SalesPersonBaseSchema, t.Object({password:t.Optional(t.String({minLength:8}))}) ]));
const SalesPersonSchema=t.Object({ id:t.Integer(), name: t.String({minLength:1}), username: t.String({minLength:3}), is_active:t.Boolean() });
const _UserCoreSchema=t.Object({mobile_number:t.String({minLength:10,maxLength:15}),company_name:t.String({minLength:1}),sales_person_id:t.Numeric(),gst_number:t.Optional(t.Nullable(t.String({minLength:15,maxLength:15}))),pan_number:t.Optional(t.Nullable(t.String({minLength:10,maxLength:10})))});
const UserBaseSchema=_UserCoreSchema;
const UserUpdateSchema=t.Optional(t.Object({gst_number:t.Optional(t.Nullable(t.String({minLength:15,maxLength:15}))),pan_number:t.Optional(t.Nullable(t.String({minLength:10,maxLength:10}))),company_name:t.Optional(t.String({minLength:1})),sales_person_id:t.Optional(t.Numeric()),is_active:t.Optional(t.Boolean()),can_register_serials:t.Optional(t.Boolean()),admin_note:t.Optional(t.Nullable(t.String()))}));
const UserSchema = t.Object({ id: t.Integer(), mobile_number: t.String({minLength:10,maxLength:15}), company_name: t.String({minLength:1}), sales_person_id: t.Numeric(), gst_number: t.Optional(t.Nullable(t.String({minLength:15,maxLength:15}))), pan_number: t.Optional(t.Nullable(t.String({minLength:10,maxLength:10}))), is_active: t.Boolean(), can_register_serials: t.Boolean(), admin_note: t.Optional(t.Nullable(t.String())), sales_person_name: t.Optional(t.Nullable(t.String())), created_at: t.Nullable(t.String({ format: 'date-time' })), updated_at: t.Nullable(t.String({ format: 'date-time' })) });
const ProductBaseSchema=t.Object({name:t.String({minLength:1}),description:t.Optional(t.Nullable(t.String()))});
const ProductCreateSchema=ProductBaseSchema;
const ProductUpdateSchema=t.Partial(ProductBaseSchema);
const ProductSchema = t.Object({ id: t.Integer(), name: t.String({minLength:1}), description: t.Optional(t.Nullable(t.String())), total_uploaded: t.Integer({default:0}), total_assigned: t.Integer({default:0}), inventory_left: t.Integer({default:0}) });
const ProductCreateResponseSchema = t.Object({ id: t.Integer(), name: t.String({minLength:1}), description: t.Optional(t.Nullable(t.String())) });
const SerialNumberBaseSchema=t.Object({serial_number:t.String({minLength:1})});
const SerialNumberSchema=t.Object({ id:t.Integer(), serial_number:t.String({minLength:1}), product_id:t.Integer(), user_id:t.Optional(t.Nullable(t.Integer())), registration_date:t.Optional(t.Nullable(t.String({ format: 'date-time' }))), bill_filename:t.Optional(t.Nullable(t.String())), bill_url:t.Optional(t.Nullable(t.String())), status:t.String(), product_name:t.Optional(t.Nullable(t.String())), owner_mobile:t.Optional(t.Nullable(t.String())), owner_company:t.Optional(t.Nullable(t.String())), });
const SerialNumberBasicSchema=t.Object({serial_number:t.String(),product_name:t.Optional(t.Nullable(t.String()))});
const ProductDetailFetchSchema=t.Object({serial_number:t.String(),product_name:t.Optional(t.Nullable(t.String())),product_description:t.Optional(t.Nullable(t.String())),status:t.String()});
const LoginRequestSchema=t.Object({mobile_number:t.String()});const AdminLoginRequestSchema=t.Object({username:t.String(),password:t.String()});const SalesPersonLoginRequestSchema=t.Object({username:t.String(),password:t.String()}); const SignupResponseSchema = t.Object({success: t.Boolean(), userId: t.Numeric()});
const BannerBaseForUpdateSchema=t.Object({ link_url:t.Optional(t.Nullable(t.String({format:'uri'}))), alt_text:t.Optional(t.Nullable(t.String())), is_active:t.Boolean({default:true}) });
const BannerCreateBodySchema = t.Object({ link_url: t.Optional(t.Nullable(t.String({ format: 'uri' }))), alt_text: t.Optional(t.Nullable(t.String())), is_active: t.Optional(t.String()), image_file: t.File({ maxSize: `${MAX_FILE_SIZE_MB}m`, types: Array.from(ALLOWED_BANNER_EXTENSIONS).map(ext => `image/${ext}`) }) });
const BannerUpdateBodySchema = t.Partial(t.Intersect([ BannerBaseForUpdateSchema, t.Object({ image_file: t.Optional(t.File({ maxSize: `${MAX_FILE_SIZE_MB}m`, types: Array.from(ALLOWED_BANNER_EXTENSIONS).map(ext => `image/${ext}`) })) }) ]));
const BannerSchema=t.Object({ id:t.Integer(), link_url:t.Optional(t.Nullable(t.String({format:'uri'}))), alt_text:t.Optional(t.Nullable(t.String())), is_active:t.Boolean(), image_url:t.Optional(t.Nullable(t.String())), created_at:t.Nullable(t.String({ format: 'date-time' })) });
const SettingSchema=t.Object({key:t.String(),value:t.Optional(t.Nullable(t.String()))});
const SettingUpdateSchema = t.Object({ value: t.Optional(t.Nullable(t.String())) });
const AuditLogSchema=t.Object({ id:t.Integer(), timestamp:t.Nullable(t.String()), admin_username:t.Optional(t.Nullable(t.String())), sales_person_username:t.Optional(t.Nullable(t.String())), acting_identifier:t.Optional(t.Nullable(t.String())), action:t.String(), target_type:t.Optional(t.Nullable(t.String())), target_id:t.Optional(t.Nullable(t.String())), details:t.Optional(t.Nullable(t.String())) });
const AuditLogQuerySchema = t.Object({ skip: t.Optional(t.Numeric({ minimum: 0, default: 0 })), limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 100 })), action: t.Optional(t.String()), target_type: t.Optional(t.String()), acting_identifier: t.Optional(t.String()) });
const StringListSchema=t.Array(t.String({minLength:1})); const BulkAddSerialsResponseSchema = t.Object({ added_count: t.Integer(), duplicates_found: t.Array(t.String()), errors: t.Array(t.String()), });
const UserSerialRegistrationSchema = t.Object({ serial_number: t.String({ minLength: 1 }), bill_file: t.File({ maxSize: `${MAX_FILE_SIZE_MB}m`, types: Array.from(ALLOWED_BILL_EXTENSIONS).map(ext => `application/${ext === 'pdf' ? 'pdf' : `image/${ext === 'jpeg' ? 'jpeg' : ext}`}`) }) });
const SchemeProductRequirementInputSchema = t.Object({
  product_id: t.Integer(),
  quantity: t.Integer({minimum: 1, default: 1}),
  is_mandatory: t.Optional(t.Boolean({default: false})),
  is_excluded: t.Optional(t.Boolean({default: false}))
});
const SchemeBaseSchema = t.Object({
  name: t.String({minLength: 1}),
  start_date: t.String({format: 'date', error: "Start date must be a valid date in YYYY-MM-DD format."}),
  end_date: t.String({format: 'date', error: "End date must be a valid date in YYYY-MM-DD format."}),
  min_products_required: t.Numeric({minimum: 1, default: 1}),
  is_active: t.Optional(t.Boolean({default: true})),
  description: t.Optional(t.Nullable(t.String()))
});
const SchemeCreateSchema = t.Intersect([
  SchemeBaseSchema,
  t.Object({
    products: t.Optional(t.Array(SchemeProductRequirementInputSchema, {default: []}))
  })
]);
const SchemeUpdateSchema = t.Partial(t.Intersect([
  SchemeBaseSchema,
  t.Object({
    products: t.Optional(t.Array(SchemeProductRequirementInputSchema))
  })
]));
const SchemeSchema = t.Object({
  id: t.Integer(),
  name: t.String({minLength: 1}),
  start_date: t.String(),
  end_date: t.String(),
  min_products_required: t.Integer({minimum: 1}),
  is_active: t.Boolean(),
  description: t.Optional(t.Nullable(t.String())),
  created_at: t.Nullable(t.String({format: 'date-time'})),
  updated_at: t.Nullable(t.String({format: 'date-time'}))
});
const SchemeProductRequirementSchema = t.Object({
  id: t.Integer(),
  product_id: t.Integer(),
  scheme_id: t.Integer(),
  product_name: t.String(),
  quantity: t.Integer({minimum: 1, default: 1}),
  is_mandatory: t.Boolean(),
  is_excluded: t.Boolean()
});
const SchemeWithProductsSchema = t.Object({
  scheme: SchemeSchema,
  products: t.Array(SchemeProductRequirementSchema)
});

// ==============================================================================
// 5. Rate Limiter
// ==============================================================================
interface LoginAttempt { count: number; windowStart: number; } const userLoginAttempts = new Map<string, LoginAttempt>(); function checkRateLimit(mobile: string): { allowed: boolean; retryAfter?: number } { const now = Date.now(); const record = userLoginAttempts.get(mobile); if (record) { const timePassed = now - record.windowStart; if (timePassed < LOGIN_ATTEMPTS_WINDOW_MS) { if (record.count >= LOGIN_ATTEMPTS_LIMIT) { const retryAfterSeconds = Math.ceil((LOGIN_ATTEMPTS_WINDOW_MS - timePassed) / 1000); return { allowed: false, retryAfter: retryAfterSeconds }; } else { userLoginAttempts.set(mobile, { count: record.count + 1, windowStart: record.windowStart }); return { allowed: true }; } } } userLoginAttempts.set(mobile, { count: 1, windowStart: now }); return { allowed: true }; } setInterval(() => { const now = Date.now(); for (const [mobile, record] of userLoginAttempts.entries()) { if (now - record.windowStart > LOGIN_ATTEMPTS_WINDOW_MS) { userLoginAttempts.delete(mobile); } } }, LOGIN_ATTEMPTS_WINDOW_MS);

// ==============================================================================
// 6. File Handling
// ==============================================================================
function isAllowedFile(filename: string | undefined, allowedExtensions: Set<string>): boolean { if (!filename) return false; const ext = filename.split('.').pop()?.toLowerCase(); return !!ext && allowedExtensions.has(ext); }
function generateUniqueFilename(originalFilename: string, prefix: string = ""): string { const timestamp = new Date().toISOString().replace(/[-:.]/g, ""); const extension = path.extname(originalFilename); const uniqueId = randomUUID().substring(0, 8); const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20); return `${safePrefix}${timestamp}_${uniqueId}${extension}`; }
async function saveUploadFile( file: File | undefined | null, destinationDir: string, prefix: string, allowedExtensions: Set<string>, maxSize: number ): Promise<string> { 
    if (!file || !file.name || !file.type || !file.size) {
        cmdLog(`❌ File upload failed - Invalid file object or missing file`);
        throw new ParseError("Invalid file object provided or file is missing."); 
    } 
    
    cmdLog(`📁 File upload attempt - Name: ${file.name}, Size: ${(file.size/1024).toFixed(2)}KB, Type: ${file.type}`);
    
    if (!isAllowedFile(file.name, allowedExtensions)) { 
        cmdLog(`❌ File upload rejected - Invalid file type: ${file.name}`);
        throw new ValidationError('File Upload', undefined as any, 
            `Invalid file type for '${file.name}'. Allowed: ${Array.from(allowedExtensions).join(',')}`); 
    } 
    
    if (file.size > maxSize) { 
        cmdLog(`❌ File upload rejected - Size too large: ${file.name} (${(file.size/1024/1024).toFixed(2)}MB)`);
        throw new ValidationError('File Upload', undefined as any, 
            `File '${file.name}' size exceeds limit of ${maxSize / (1024 * 1024)} MB`); 
    } 
    
    const uniqueFilename = generateUniqueFilename(file.name, prefix); 
    const destinationPath = path.join(destinationDir, uniqueFilename); 
    
    try { 
        await fs.mkdir(destinationDir, { recursive: true }); 
        await Bun.write(destinationPath, await file.arrayBuffer()); 
        cmdLog(`✅ File uploaded successfully - Original: '${file.name}', Saved as: '${uniqueFilename}'`);
        console.log(`[File] Successfully saved '${file.name}' as '${uniqueFilename}' to ${destinationPath}`); 
        return uniqueFilename; 
    } catch (err: any) { 
        console.error(`[File] Error saving file '${uniqueFilename}': ${err.message}`, err); 
        cmdLog(`❌ File upload failed during write - Name: ${file.name}, Error: ${err.message}`);
        
        try { 
            await fs.unlink(destinationPath); 
        } catch (cleanupErr) { 
            console.error(`[File] Error cleaning up partially saved file '${uniqueFilename}':`, cleanupErr); 
        } 
        throw new InternalServerError(`Failed to save uploaded file '${file.name}'.`); 
    } 
}
async function deleteUploadedFile(filename: string, destinationDir: string): Promise<boolean> { if (!filename) return false; const filePath = path.join(destinationDir, filename); try { await fs.access(filePath); await fs.unlink(filePath); console.log(`[File] Successfully deleted file: ${filePath}`); return true; } catch (error: any) { if (error.code === 'ENOENT') { console.warn(`[File] File not found for deletion, skipping: ${filePath}`); return false; } console.error(`[File] Error deleting file '${filePath}': ${error.message}`, error); return false; } }
async function parseCsvSerials(file: Blob): Promise<string[]> { try { const textContent = await file.text(); const lines = textContent.split(/\r?\n/); const serials = lines.map(line => line.split(',')[0].trim()).filter(serial => serial.length > 0).slice(1); return serials; } catch (e) { console.error("Error parsing CSV:", e); throw new Error("Failed to parse CSV file."); } }

// ==============================================================================
// 7. CRUD/Service Functions
// ==============================================================================
function formatDbDate(date: string | Date | null | undefined): string | null { if (!date) return null; try { return new Date(date).toISOString(); } catch (e) { console.warn(`[Date Format] Failed to format date: ${date}`, e); return null; } }
async function crud_log_action( actingIdentifier: string | null, action: string, targetType?: string, targetId?: string | number | null, details?: Record<string, any> | string | null, salesPersonUsername?: string | null ) { 
    const db = getDb(); 
    try { 
        // Create the log entry data
        const logEntry = {
            acting_identifier: actingIdentifier,
            admin_username: actingIdentifier === CONFIG_ADMIN_USERNAME ? actingIdentifier : null,
            sales_person_username: salesPersonUsername,
            action,
            target_type: targetType,
            target_id: targetId ? String(targetId) : null,
            details: details ? JSON.stringify(details) : null,
            timestamp: new Date().toISOString()
        };
        
        // First attempt - try immediate insertion
        try {
            await db('audit_logs').insert(logEntry);
            return;
        } catch (initialError: any) {
            // If database is busy or locked, retry with exponential backoff
            if (initialError?.code === "SQLITE_BUSY" || initialError?.errno === 5) {
                // Retry the insertion with backoff
                const retryPromise = new Promise<void>((resolve) => {
                    setTimeout(async () => {
                        try {
                            await db('audit_logs').insert(logEntry);
                            resolve();
                        } catch (retryError) {
                            console.error(`[DB] Retry failed for action logging '${action}':`, retryError);
                            resolve(); // Resolve anyway to prevent hanging
                        }
                    }, 500); // Wait 500ms before retry
                });
                
                await retryPromise;
            } else {
                // For other errors, log and continue
                throw initialError;
            }
        }
    } catch (error) {
        console.error(`[DB] Failed to log action '${action}':`, error);
    }
}
async function crud_get_audit_logs(query: Static<typeof AuditLogQuerySchema>): Promise<{ logs: Static<typeof AuditLogSchema>[], total: number, skip: number, limit: number }> { const db = getDb(); const { skip = 0, limit = 100, action, target_type, acting_identifier } = query; try { let dbQuery = db('audit_logs').orderBy('timestamp', 'desc').offset(skip).limit(limit); if (action) dbQuery = dbQuery.where('action', 'like', `%${action}%`); if (target_type) dbQuery = dbQuery.where('target_type', 'like', `%${target_type}%`); if (acting_identifier) dbQuery = dbQuery.where((builder) => builder.where('acting_identifier', 'like', `%${acting_identifier}%`).orWhere('admin_username', 'like', `%${acting_identifier}%`).orWhere('sales_person_username', 'like', `%${acting_identifier}%`)); const logsRaw = await dbQuery; const logs: Static<typeof AuditLogSchema>[] = logsRaw.map(log => ({ id: log.id, timestamp: formatDbDate(log.timestamp), admin_username: log.admin_username, sales_person_username: log.sales_person_username, acting_identifier: log.acting_identifier, action: log.action, target_type: log.target_type, target_id: log.target_id, details: typeof log.details === 'string' ? log.details : null })); const totalCountQuery = db('audit_logs'); if (action) totalCountQuery.where('action', 'like', `%${action}%`); if (target_type) totalCountQuery.where('target_type', 'like', `%${target_type}%`); if (acting_identifier) totalCountQuery.where((builder) => builder.where('acting_identifier', 'like', `%${acting_identifier}%`).orWhere('admin_username', 'like', `%${acting_identifier}%`).orWhere('sales_person_username', 'like', `%${acting_identifier}%`)); const totalResult = await totalCountQuery.count({ count: '*' }).first(); const total = Number(totalResult?.count || 0); return { logs, total, skip, limit }; } catch (dbError: any) { console.error("[DB Error] Failed to retrieve audit logs:", dbError); throw new InternalServerError("Failed to retrieve audit logs due to a database issue."); } }
async function crud_findUserByMobile(mobile_number: string) { return getDb()('users').where({ mobile_number }).first(); }
async function crud_checkGstExists(gst_number: string): Promise<boolean> { const result = await getDb()('users').where({ gst_number }).first('id'); return !!result; }
async function crud_checkPanExists(pan_number: string): Promise<boolean> { const result = await getDb()('users').where({ pan_number }).first('id'); return !!result; }
async function crud_createUser(userData: Static<typeof UserBaseSchema>): Promise<Static<typeof UserSchema>> { 
    const db = getDb(); 
    const { mobile_number, gst_number, pan_number, sales_person_id, company_name } = userData; 
    cmdLog(`👤 User creation attempt - Mobile: ${mobile_number}, Company: ${company_name}`);
    
    try { 
        if (await crud_findUserByMobile(mobile_number)) { 
            cmdLog(`❌ User creation failed - Mobile ${mobile_number} already registered`);
            throw { statusCode: 409, message: 'Mobile number already registered.' }; 
        } 
        if (gst_number && await crud_checkGstExists(gst_number)) { 
            cmdLog(`❌ User creation failed - GST ${gst_number} already registered`);
            throw { statusCode: 409, message: 'GST number already registered.' }; 
        } 
        if (pan_number && await crud_checkPanExists(pan_number)) { 
            cmdLog(`❌ User creation failed - PAN ${pan_number} already registered`);
            throw { statusCode: 409, message: 'PAN number already registered.' }; 
        } 
        if (!gst_number && !pan_number) { 
            cmdLog(`❌ User creation failed - Neither GST nor PAN provided`);
            throw { statusCode: 422, message: 'Either GST number or PAN number must be provided.'}; 
        } 
        
        const salesPerson = await db('salespersons').where({ id: sales_person_id, is_active: true }).first('id'); 
        if (!salesPerson) { 
            cmdLog(`❌ User creation failed - SalesPerson ID ${sales_person_id} not found or inactive`);
            throw { statusCode: 404, message: 'Active sales person not found.'}; 
        } 
        
        const [userIdResult] = await db('users').insert({ 
            mobile_number, 
            gst_number, 
            pan_number, 
            company_name, 
            sales_person_id, 
            can_register_serials: true, 
            is_active: true, 
            created_at: new Date().toISOString(), 
            updated_at: new Date().toISOString() 
        }).returning('id'); 
        
        const userId = typeof userIdResult === 'object' ? userIdResult.id : userIdResult; 
        if (!userId) throw new InternalServerError('User insert failed: No ID returned'); 
        
        const newUserDetails = await crud_getUserDetails(userId); 
        if (!newUserDetails) throw new InternalServerError('User creation failed: Could not fetch created user.'); 
        
        await crud_log_action(null, 'user_signup', 'User', userId, { mobile_number }); 
        cmdLog(`✅ User created successfully - ID: ${userId}, Mobile: ${mobile_number}`);
        return newUserDetails; 
    } catch (error: any) { 
        if (error?.statusCode) throw error; 
        console.error(`[crud_createUser] Error for ${mobile_number}:`, error); 
        cmdLog(`❌ User creation failed with database error - Mobile: ${mobile_number}`);
        throw new InternalServerError(`Database error during user creation: ${error.message || 'Unknown DB Error'}`); 
    } 
}
async function crud_getUserDetails(userId: number): Promise<Static<typeof UserSchema> | null> { const db = getDb(); const user = await db('users') .where('users.id', userId) .leftJoin('salespersons', 'users.sales_person_id', 'salespersons.id') .select( 'users.id', 'users.mobile_number', 'users.company_name', 'users.gst_number', 'users.pan_number', 'users.is_active', 'users.can_register_serials', 'users.admin_note', 'users.sales_person_id', 'users.created_at', 'users.updated_at', 'salespersons.name as sales_person_name' ) .first(); if (user) { return { id: user.id, mobile_number: user.mobile_number, company_name: user.company_name, sales_person_id: user.sales_person_id, gst_number: user.gst_number, pan_number: user.pan_number, is_active: Boolean(user.is_active), can_register_serials: Boolean(user.can_register_serials), admin_note: user.admin_note, sales_person_name: user.sales_person_name, created_at: formatDbDate(user.created_at), updated_at: formatDbDate(user.updated_at) }; } return null; }

async function crud_admin_update_user(userId: number, updateData: Static<typeof UserUpdateSchema>, actingAdminIdentifier: string): Promise<Static<typeof UserSchema>> {
    const db = getDb();
    const user = await db('users').where({ id: userId }).first();
    if (!user) {
        throw new NotFoundError('User not found');
    }

    const changes: Record<string, any> = {};
    const dataToUpdate: Record<string, any> = {};

    // Explicitly iterate over keys present in updateData to avoid issues with optional fields
    (Object.keys(updateData) as Array<keyof typeof updateData>).forEach(key => {
        if (updateData[key] !== undefined && updateData[key] !== (user as any)[key]) {
            dataToUpdate[key] = updateData[key];
            changes[key] = { old: (user as any)[key], new: updateData[key] };
        }
    });

    if (dataToUpdate.sales_person_id) {
        const salesPerson = await db('salespersons').where({ id: dataToUpdate.sales_person_id, is_active: true }).first('id');
        if (!salesPerson) {
            throw { statusCode: 404, message: `Active sales person with ID ${dataToUpdate.sales_person_id} not found.` };
        }
    }
    if (dataToUpdate.gst_number) {
        const existing = await db('users').where('gst_number', dataToUpdate.gst_number).whereNot('id', userId).first('id');
        if (existing) {
            throw { statusCode: 409, message: `GST number ${dataToUpdate.gst_number} already exists.` };
        }
    }
    if (dataToUpdate.pan_number) {
        const existing = await db('users').where('pan_number', dataToUpdate.pan_number).whereNot('id', userId).first('id');
        if (existing) {
            throw { statusCode: 409, message: `PAN number ${dataToUpdate.pan_number} already exists.` };
        }
    }

    const finalGst = dataToUpdate.gst_number !== undefined ? dataToUpdate.gst_number : user.gst_number;
    const finalPan = dataToUpdate.pan_number !== undefined ? dataToUpdate.pan_number : user.pan_number;
    if (!finalGst && !finalPan) {
        throw { statusCode: 422, message: 'Cannot remove both GST and PAN number.' };
    }

    if (Object.keys(dataToUpdate).length === 0) {
        const currentUserDetails = await crud_getUserDetails(userId);
        if (!currentUserDetails) { // Added block for clarity and to prevent ASI issues
            throw new InternalServerError("Failed to fetch user details after no-op update.");
        }
        return currentUserDetails; // Semicolon was not an issue here but good practice with blocks
    }

    if (dataToUpdate.is_active !== undefined) {
        dataToUpdate.is_active = dataToUpdate.is_active ? 1 : 0;
    }
    if (dataToUpdate.can_register_serials !== undefined) {
        dataToUpdate.can_register_serials = dataToUpdate.can_register_serials ? 1 : 0;
    }
    dataToUpdate.updated_at = new Date().toISOString();

    await db('users').where({ id: userId }).update(dataToUpdate);
    await crud_log_action(actingAdminIdentifier, 'admin_update_user', 'User', String(userId), changes);
    
    const updatedUserDetails = await crud_getUserDetails(userId);
    if (!updatedUserDetails) { // Added block
        throw new InternalServerError("Failed to fetch user details after update.");
    }
    return updatedUserDetails; // Semicolon was not an issue here
}

async function crud_delete_user(userId: number, actingAdminIdentifier: string, hardDelete: boolean = false): Promise<Static<typeof SuccessStatusSchema>> { const db = getDb(); const user = await db('users').where({ id: userId }).first(); if (!user) throw new NotFoundError('User not found'); if (hardDelete) { const deletedRows = await db('users').where({ id: userId }).del(); if (deletedRows > 0) { await crud_log_action(actingAdminIdentifier, 'admin_hard_delete_user', 'User', String(userId), { mobile: user.mobile_number }); return { success: true, message: `User ${userId} permanently deleted.` }; } else { throw new InternalServerError(`Failed to hard delete user ${userId}`); } } else { if (!user.is_active) { return { success: true, message: `User ${userId} is already inactive.` }; } await db('users').where({ id: userId }).update({ is_active: false, updated_at: new Date().toISOString() }); await crud_log_action(actingAdminIdentifier, 'admin_soft_delete_user', 'User', String(userId), { change: { is_active: { old: true, new: false } } }); return { success: true, message: `User ${userId} marked as inactive.` }; } }
async function crud_createProduct(productData: Static<typeof ProductCreateSchema>, actingIdentifier: string): Promise<Static<typeof ProductCreateResponseSchema>> { const db = getDb(); const [productIdResult] = await db('products').insert(productData).returning('id'); const productId = typeof productIdResult === 'object' ? productIdResult.id : productIdResult; if (!productId) throw new InternalServerError('Product insert failed: No ID returned'); await crud_log_action(actingIdentifier, 'create_product', 'Product', String(productId), productData); return { id: productId, name: productData.name, description: productData.description }; }
async function crud_getProductInventory(productId: number): Promise<{ total_uploaded: number, total_assigned: number, inventory_left: number }> { const db = getDb(); const counts = await db('serialnumbers') .select( db.raw('count(*) as total_uploaded'), db.raw('count(case when user_id is not null then 1 else null end) as total_assigned') ) .where({ product_id: productId }) .first(); const total_uploaded = Number(counts?.total_uploaded || 0); const total_assigned = Number(counts?.total_assigned || 0); return { total_uploaded, total_assigned, inventory_left: total_uploaded - total_assigned }; }
async function crud_getProductsWithInventory(skip: number = 0, limit: number = 100, filters: Record<string, any> = {}): Promise<Static<typeof ProductSchema>[]> { const db = getDb(); let query = db('products'); if (filters.name_like) { query = query.where('name', 'like', `%${filters.name_like}%`); } const products = await query.orderBy('name').offset(skip).limit(limit); const results: Static<typeof ProductSchema>[] = []; for (const p of products) { const inventory = await crud_getProductInventory(p.id); results.push({ id: p.id, name: p.name, description: p.description, ...inventory }); } return results; }
async function crud_getProductById(productId: number) { return getDb()('products').where({ id: productId }).first(); }
async function crud_getProductByIdWithInventory(productId: number): Promise<Static<typeof ProductSchema> | null> { const db = getDb(); const product = await db('products').where({ id: productId }).first(); if (!product) return null; const inventory = await crud_getProductInventory(productId); return { id: product.id, name: product.name, description: product.description, ...inventory }; }
async function crud_update_product(productId: number, productUpdate: Static<typeof ProductUpdateSchema>, actingIdentifier: string): Promise<Static<typeof ProductSchema> | null> { const db = getDb(); const product = await db('products').where({ id: productId }).first(); if (!product) throw new NotFoundError('Product not found'); const updateData: Partial<Static<typeof ProductUpdateSchema>> = {}; const changes: Record<string, any> = {}; if (productUpdate.name !== undefined && productUpdate.name !== product.name) { updateData.name = productUpdate.name; changes['name'] = { old: product.name, new: updateData.name }; } if (productUpdate.description !== undefined && productUpdate.description !== product.description) { updateData.description = productUpdate.description; changes['description'] = { old: product.description, new: updateData.description }; } if (Object.keys(updateData).length > 0) { await db('products').where({ id: productId }).update(updateData); await crud_log_action(actingIdentifier, 'update_product', 'Product', String(productId), changes); return await crud_getProductByIdWithInventory(productId); } else { return await crud_getProductByIdWithInventory(productId); } }
async function crud_delete_product(productId: number, actingIdentifier: string): Promise<boolean> { const db = getDb(); const product = await db('products').where({ id: productId }).first(); if (!product) throw new NotFoundError('Product not found'); const serialCountResult = await db('serialnumbers').where({ product_id: productId }).count({ count: '*' }).first(); const count = Number(serialCountResult?.count || 0); if (count > 0) { throw { statusCode: 409, message: `Cannot delete product ${productId} with ${count} existing serial numbers.` }; } await crud_log_action(actingIdentifier, 'delete_product', 'Product', String(productId), { name: product.name }); const deletedRows = await db('products').where({ id: productId }).del(); return deletedRows > 0; }
async function crud_add_serial_numbers(productId: number, serialNumbers: string[], actingIdentifier: string): Promise<Static<typeof BulkAddSerialsResponseSchema>> { const db = getDb(); let added_count = 0; const duplicates_found: string[] = []; const errors: string[] = []; const serials_to_add: { serial_number: string; product_id: number; status: string }[] = []; const processed_in_batch = new Set<string>(); const unique_input_serials = [...new Set(serialNumbers.map(s => s.trim()).filter(s => s))]; if (unique_input_serials.length === 0) return { added_count: 0, duplicates_found: [], errors: ["No valid serial numbers provided."] }; try { const existingSerials = await db('serialnumbers').whereIn('serial_number', unique_input_serials).pluck('serial_number'); const existingSet = new Set(existingSerials); for (const sn of unique_input_serials) { if (processed_in_batch.has(sn)) continue; processed_in_batch.add(sn); if (existingSet.has(sn)) { duplicates_found.push(sn); } else { serials_to_add.push({ serial_number: sn, product_id: productId, status: 'available' }); } } if (serials_to_add.length > 0) { await db.transaction(async trx => { await trx('serialnumbers').insert(serials_to_add); }); added_count = serials_to_add.length; await crud_log_action(actingIdentifier, 'bulk_add_serials', 'Product', String(productId), `Added ${added_count}. Duplicates skipped: ${duplicates_found.length}. Unique inputs: ${unique_input_serials.length}`); } return { added_count, duplicates_found, errors }; } catch (error: any) { console.error(`[DB] Bulk insert serials failed for product ${productId}:`, error); errors.push(`Database batch insert failed: ${error.message}`); return { added_count: 0, duplicates_found, errors }; } }
async function crud_get_serials_by_user(userId: number): Promise<Static<typeof SerialNumberSchema>[]> { const db = getDb(); const serialsRaw = await db('serialnumbers as sn') .leftJoin('products as p', 'sn.product_id', 'p.id') .leftJoin('users as u', 'sn.user_id', 'u.id') .select( 'sn.id', 'sn.serial_number', 'sn.product_id', 'sn.user_id', 'sn.registration_date', 'sn.bill_filename', 'sn.status', 'p.name as product_name', 'u.mobile_number as owner_mobile', 'u.company_name as owner_company' ) .where('sn.user_id', userId) .orderBy('sn.registration_date', 'desc'); return serialsRaw.map(s => ({ id: s.id, serial_number: s.serial_number, product_id: s.product_id, user_id: s.user_id, registration_date: formatDbDate(s.registration_date), bill_filename: s.bill_filename, bill_url: s.bill_filename ? `${STATIC_ASSETS_ROUTE}/${BILL_UPLOAD_SUBDIR_NAME}/${s.bill_filename}` : null, status: s.status, product_name: s.product_name, owner_mobile: s.owner_mobile, owner_company: s.owner_company })); }
async function crud_get_serial_by_number_with_details(serialNumber: string): Promise<Static<typeof SerialNumberSchema> | null> { const db = getDb(); const serialRaw = await db('serialnumbers as sn') .leftJoin('products as p', 'sn.product_id', 'p.id') .leftJoin('users as u', 'sn.user_id', 'u.id') .select( 'sn.id', 'sn.serial_number', 'sn.product_id', 'sn.user_id', 'sn.registration_date', 'sn.bill_filename', 'sn.status', 'p.name as product_name', 'u.mobile_number as owner_mobile', 'u.company_name as owner_company' ) .where('sn.serial_number', serialNumber) .first(); if (!serialRaw) return null; return { id: serialRaw.id, serial_number: serialRaw.serial_number, product_id: serialRaw.product_id, user_id: serialRaw.user_id, registration_date: formatDbDate(serialRaw.registration_date), bill_filename: serialRaw.bill_filename, bill_url: serialRaw.bill_filename ? `${STATIC_ASSETS_ROUTE}/${BILL_UPLOAD_SUBDIR_NAME}/${serialRaw.bill_filename}` : null, status: serialRaw.status, product_name: serialRaw.product_name, owner_mobile: serialRaw.owner_mobile, owner_company: serialRaw.owner_company }; }
async function crud_get_serials_by_product(productId: number, skip: number = 0, limit: number = 50): Promise<Static<typeof SerialNumberSchema>[]> {
    const db = getDb();
    // First check if the product exists
    const product = await db('products').where({ id: productId }).first();
    if (!product) throw new NotFoundError(`Product with ID ${productId} not found`);
    
    // Get all serial numbers for this product with their associated data
    const serialsRaw = await db('serialnumbers as sn')
        .where('sn.product_id', productId)
        .leftJoin('products as p', 'sn.product_id', 'p.id')
        .leftJoin('users as u', 'sn.user_id', 'u.id')
        .select(
            'sn.id', 'sn.serial_number', 'sn.product_id',
            'sn.user_id', 'sn.registration_date', 'sn.bill_filename', 
            'sn.status', 'p.name as product_name',
            'u.mobile_number as owner_mobile', 'u.company_name as owner_company'
        )
        .orderBy('sn.id', 'desc')
        .offset(skip)
        .limit(limit);
    
    // Transform the raw database results into the expected schema format
    return serialsRaw.map(s => ({
        id: s.id,
        serial_number: s.serial_number,
        product_id: s.product_id,
        user_id: s.user_id,
        registration_date: formatDbDate(s.registration_date),
        bill_filename: s.bill_filename,
        bill_url: s.bill_filename ? `${STATIC_ASSETS_ROUTE}/${BILL_UPLOAD_SUBDIR_NAME}/${s.bill_filename}` : null,
        status: s.status,
        product_name: s.product_name,
        owner_mobile: s.owner_mobile,
        owner_company: s.owner_company
    }));
}

async function crud_disassociate_serial(serialNumber: string, actingAdminIdentifier: string): Promise<Static<typeof SerialNumberSchema>> {
    const db = getDb();
    const serial = await db('serialnumbers').where({serial_number: serialNumber}).first();
    if (!serial) {
        throw new NotFoundError('Serial number not found.');
    }
    if (serial.status !== 'registered' || !serial.user_id) {
        throw { statusCode: 400, message: 'Serial number is not currently registered to a user.' };
    }
    const oldUserId = serial.user_id;

    const updateData = { user_id: null, status: 'available', registration_date: null, bill_filename: null };
    const updatedRows = await db('serialnumbers').where({ id: serial.id }).update(updateData);

    if (updatedRows > 0) {
        await crud_log_action(actingAdminIdentifier, 'disassociate_serial', 'SerialNumber', serialNumber, { disassociated_from_user: oldUserId });
        const disassociatedSerialDetails = await crud_get_serial_by_number_with_details(serialNumber);
        if(!disassociatedSerialDetails) { // Added block for clarity
            throw new InternalServerError("Failed to fetch details of disassociated serial.");
        }
        return disassociatedSerialDetails; // Semicolon was not an issue here
    } else {
        throw new InternalServerError('Failed to update serial number status during disassociation.');
    }
}

async function crud_register_serial_for_user( userId: number, serialNumber: string, billFilename: string, actingUserIdentifier: string ): Promise<Static<typeof SerialNumberSchema>> { 
    const db = getDb(); 
    cmdLog(`📝 Serial registration attempt - Serial: ${serialNumber}, User: ${userId}`);
    
    const user = await db('users').where({ id: userId, is_active: true, can_register_serials: true }).first(); 
    if (!user) {
        cmdLog(`❌ Serial registration failed - User ${userId} not found, inactive, or cannot register`);
        throw new NotFoundError('User not found, is inactive, or cannot register serials.'); 
    }
    
    const serial = await db('serialnumbers').where({ serial_number: serialNumber }).first(); 
    if (!serial) {
        cmdLog(`❌ Serial registration failed - Serial ${serialNumber} not found`);
        throw new NotFoundError(`Serial number '${serialNumber}' not found.`); 
    }
    
    if (serial.status !== 'available' || serial.user_id) { 
        cmdLog(`❌ Serial registration failed - Serial ${serialNumber} not available (status: ${serial.status}, user_id: ${serial.user_id})`);
        throw { statusCode: 409, message: `Serial number '${serialNumber}' is not available for registration.` }; 
    }
    
    const regDate = new Date();
    const updateData = { 
        user_id: userId, 
        registration_date: regDate, 
        bill_filename: billFilename, 
        status: 'registered' 
    };
    
    const updatedRows = await db('serialnumbers')
        .where({ id: serial.id, status: 'available' })
        .update(updateData); 
        
    if (updatedRows > 0) { 
        await crud_log_action(
            actingUserIdentifier, 
            'user_register_serial', 
            'SerialNumber', 
            serial.id, 
            { user_id: userId, serial_number: serialNumber, bill: billFilename }
        );
        
        const updatedSerialData = await crud_get_serial_by_number_with_details(serialNumber); 
        if (!updatedSerialData) {
            cmdLog(`❌ Serial registration failed - Could not retrieve updated serial data for ${serialNumber}`);
            throw new InternalServerError('Failed to retrieve updated serial data after registration.');
        }
        
        cmdLog(`✅ Serial registered successfully - Serial: ${serialNumber}, User: ${userId}, Product: ${updatedSerialData.product_name || 'Unknown'}`);
        return updatedSerialData; 
    } else {
        cmdLog(`❌ Serial registration failed - Race condition or concurrent access for ${serialNumber}`); 
        throw new InternalServerError('Failed to register serial number. It might have been registered by another user simultaneously.'); 
    }
}
async function crud_createSalesPerson(data: Static<typeof SalesPersonCreateSchema>, actingAdminIdentifier: string): Promise<Static<typeof SalesPersonSchema>> { const db = getDb(); const { username, password, name, is_active = true } = data; const existing = await db('salespersons').where({ username }).first(); if (existing) { throw { statusCode: 409, message: `Salesperson with username '${username}' already exists.` }; } const hashedPassword = await Bun.password.hash(password); const [newIdResult] = await db('salespersons').insert({ name, username, password: hashedPassword, is_active }).returning('id'); const newId = typeof newIdResult === 'object' ? newIdResult.id : newIdResult; await crud_log_action(actingAdminIdentifier, 'create_salesperson', 'SalesPerson', newId, { username, name: data.name, is_active }); const newSalesPerson = await db('salespersons').where({ id: newId }).select('id', 'name', 'username', 'is_active').first(); if (!newSalesPerson) throw new InternalServerError("Failed to retrieve created salesperson."); return { ...newSalesPerson, is_active: Boolean(newSalesPerson.is_active) }; }
async function crud_getSalesPersons(query: Static<typeof PaginationQuerySchema>): Promise<{ salespersons: Static<typeof SalesPersonSchema>[], total: number, skip: number, limit: number }> { const db = getDb(); const { skip = 0, limit = 100 } = query; const salespersonsRaw = await db('salespersons').select('id', 'name', 'username', 'is_active').orderBy('name').offset(skip).limit(limit); const salespersons = salespersonsRaw.map(sp => ({ ...sp, is_active: Boolean(sp.is_active) })); const totalResult = await db('salespersons').count({ count: '*' }).first(); const total = Number(totalResult?.count || 0); return { salespersons, total, skip, limit }; }
async function crud_getSalesPersonById(id: number): Promise<Static<typeof SalesPersonSchema>> { const db = getDb(); const salesperson = await db('salespersons').where({ id }).select('id', 'name', 'username', 'is_active').first(); if (!salesperson) throw new NotFoundError('Salesperson not found'); return { ...salesperson, is_active: Boolean(salesperson.is_active) }; }
async function crud_updateSalesPerson(id: number, data: Static<typeof SalesPersonUpdateSchema>, actingAdminIdentifier: string): Promise<Static<typeof SalesPersonSchema>> { const db = getDb(); const { password, username, ...rest } = data; const salesperson = await db('salespersons').where({ id }).first(); if (!salesperson) throw new NotFoundError('Salesperson not found'); const updatePayload: Record<string, any> = { ...rest }; if (data.is_active !== undefined) { updatePayload.is_active = data.is_active; } if (username && username !== salesperson.username) { const existing = await db('salespersons').where({ username }).whereNot({ id }).first(); if (existing) { throw { statusCode: 409, message: `Salesperson with username '${username}' already exists.` }; } updatePayload.username = username; } if (password) { updatePayload.password = await Bun.password.hash(password); } if (Object.keys(updatePayload).length === 0) { return crud_getSalesPersonById(id); } await db('salespersons').where({ id }).update(updatePayload); await crud_log_action(actingAdminIdentifier, 'update_salesperson', 'SalesPerson', id, data); return crud_getSalesPersonById(id); }
async function crud_deleteSalesPerson(id: number, actingAdminIdentifier: string): Promise<Static<typeof SuccessStatusSchema>> { const db = getDb(); if (id === DEFAULT_SALESPERSON_ID) { throw {statusCode: 400, message: "Cannot delete the default salesperson."}; } const salesperson = await db('salespersons').where({ id }).first(); if (!salesperson) throw new NotFoundError('Salesperson not found'); const assignedUsersCountResult = await db('users').where({ sales_person_id: id }).count({count: '*'}).first(); if (Number(assignedUsersCountResult?.count || 0) > 0) { throw { statusCode: 409, message: `Cannot delete salesperson. Reassign ${assignedUsersCountResult?.count} user(s) first.` }; } const deletedRows = await db('salespersons').where({ id }).del(); if (deletedRows > 0) { await crud_log_action(actingAdminIdentifier, 'delete_salesperson', 'SalesPerson', id, { username: salesperson.username }); return { success: true, message: `Salesperson ${id} deleted.` }; } throw new InternalServerError('Failed to delete salesperson.'); }
async function crud_createBanner(data: { link_url?: string | null, alt_text?: string | null, is_active: boolean }, imageFilename: string, actingAdminIdentifier: string): Promise<Static<typeof BannerSchema>> { const db = getDb(); const [newIdResult] = await db('banners').insert({ link_url: data.link_url, alt_text: data.alt_text, is_active: data.is_active, image_filename: imageFilename, created_at: new Date().toISOString() }).returning('id'); const newId = typeof newIdResult === 'object' ? newIdResult.id : newIdResult; await crud_log_action(actingAdminIdentifier, 'create_banner', 'Banner', newId, { ...data, image_filename: imageFilename }); const newBanner = await crud_getBannerById(newId!); if (!newBanner) throw new InternalServerError("Failed to retrieve created banner."); return newBanner; }
async function crud_getBanners(query: Static<typeof PaginationQuerySchema>, onlyActive: boolean = false): Promise<{ banners: Static<typeof BannerSchema>[], total: number, skip: number, limit: number }> { const db = getDb(); const { skip = 0, limit = 100 } = query; let qb = db('banners').select('id', 'image_filename', 'link_url', 'alt_text', 'is_active', 'created_at') .orderBy('created_at', 'desc').offset(skip).limit(limit); if (onlyActive) { qb = qb.where({ is_active: true }); } const bannersRaw = await qb; const banners: Static<typeof BannerSchema>[] = bannersRaw.map(b => ({ id: b.id, link_url: b.link_url, alt_text: b.alt_text, is_active: Boolean(b.is_active), image_url: `${STATIC_ASSETS_ROUTE}/${BANNER_UPLOAD_SUBDIR_NAME}/${b.image_filename}`, created_at: formatDbDate(b.created_at) })); let countQb = db('banners'); if(onlyActive) countQb = countQb.where({is_active: true}); const totalResult = await countQb.count({count: '*'}).first(); const total = Number(totalResult?.count || 0); return { banners, total, skip, limit }; }
async function crud_getBannerById(id: number): Promise<Static<typeof BannerSchema> | null> { const db = getDb(); const banner = await db('banners').where({ id }).first(); if (!banner) return null; return { id: banner.id, link_url: banner.link_url, alt_text: banner.alt_text, is_active: Boolean(banner.is_active), image_url: `${STATIC_ASSETS_ROUTE}/${BANNER_UPLOAD_SUBDIR_NAME}/${banner.image_filename}`, created_at: formatDbDate(banner.created_at) }; }
async function crud_updateBanner(id: number, data: Omit<Static<typeof BannerUpdateBodySchema>, 'image_file'>, newImageFilename: string | null, actingAdminIdentifier: string): Promise<Static<typeof BannerSchema>> { const db = getDb(); const banner = await db('banners').where({ id }).first(); if (!banner) throw new NotFoundError('Banner not found'); const updatePayload: Record<string, any> = {}; if (data.link_url !== undefined) updatePayload.link_url = data.link_url; if (data.alt_text !== undefined) updatePayload.alt_text = data.alt_text; if (data.is_active !== undefined) updatePayload.is_active = data.is_active; let oldImageFilename: string | null = null; if (newImageFilename) { oldImageFilename = banner.image_filename; updatePayload.image_filename = newImageFilename; } if (Object.keys(updatePayload).length === 0) { const currentBanner = await crud_getBannerById(id); if(!currentBanner) throw new InternalServerError("Failed to fetch banner details for no-op update."); return currentBanner; } await db('banners').where({ id }).update(updatePayload); await crud_log_action(actingAdminIdentifier, 'update_banner', 'Banner', id, updatePayload); if (oldImageFilename && newImageFilename && oldImageFilename !== newImageFilename) { await deleteUploadedFile(oldImageFilename, BANNER_UPLOAD_PATH); } const updatedBannerDetails = await crud_getBannerById(id); if(!updatedBannerDetails) throw new InternalServerError("Failed to fetch banner details after update."); return updatedBannerDetails; }
async function crud_deleteBanner(id: number, actingAdminIdentifier: string): Promise<Static<typeof SuccessStatusSchema>> { const db = getDb(); const banner = await db('banners').where({ id }).first(); if (!banner) throw new NotFoundError('Banner not found'); const deletedRows = await db('banners').where({ id }).del(); if (deletedRows > 0) { await deleteUploadedFile(banner.image_filename, BANNER_UPLOAD_PATH); await crud_log_action(actingAdminIdentifier, 'delete_banner', 'Banner', id, { image_filename: banner.image_filename }); return { success: true, message: `Banner ${id} deleted.` }; } throw new InternalServerError('Failed to delete banner.'); }
async function crud_getAllSettings(query: Static<typeof PaginationQuerySchema>): Promise<{ settings: Static<typeof SettingSchema>[], total: number, skip: number, limit: number }> { const db = getDb(); const { skip = 0, limit = 100 } = query; const settings = await db('settings').orderBy('key').offset(skip).limit(limit); const totalResult = await db('settings').count({count: '*'}).first(); const total = Number(totalResult?.count || 0); return { settings, total, skip, limit}; }
async function crud_getSetting(key: string): Promise<Static<typeof SettingSchema>> { const db = getDb(); const setting = await db('settings').where({ key }).first(); if (!setting) throw new NotFoundError(`Setting with key '${key}' not found.`); return setting; }
async function crud_setSetting(key: string, value: string | null, actingAdminIdentifier: string): Promise<Static<typeof SettingSchema>> { const db = getDb(); const existing = await db('settings').where({ key }).first(); const details = { key, value, old_value: existing ? existing.value : null }; if (existing) { await db('settings').where({ key }).update({ value }); } else { await db('settings').insert({ key, value }); } await crud_log_action(actingAdminIdentifier, existing ? 'update_setting' : 'create_setting', 'Setting', key, details); return { key, value }; }
async function crud_get_schemes(query: Static<typeof PaginationQuerySchema>): Promise<{ schemes: Static<typeof SchemeSchema>[], total: number, skip: number, limit: number }> { const db = getDb(); const { skip = 0, limit = 100 } = query; try { const schemesRaw = await db('schemes') .select('*') .orderBy('created_at', 'desc') .offset(skip) .limit(limit);

        const schemes: Static<typeof SchemeSchema>[] = schemesRaw.map(s => ({
            id: s.id,
            name: s.name,
            start_date: new Date(s.start_date).toISOString().split('T')[0], // Format as YYYY-MM-DD
            end_date: new Date(s.end_date).toISOString().split('T')[0], // Format as YYYY-MM-DD
            min_products_required: s.min_products_required,
            is_active: Boolean(s.is_active),
            description: s.description,
            created_at: formatDbDate(s.created_at),
            updated_at: formatDbDate(s.updated_at)
        }));

        const totalResult = await db('schemes').count({ count: '*' }).first();
        const total = Number(totalResult?.count || 0);
        return { schemes, total, skip, limit };
    } catch (dbError: any) {
        console.error("[DB Error] Failed to retrieve schemes:", dbError);
        throw new InternalServerError("Failed to retrieve schemes due to a database issue.");
    }
}

async function crud_getSchemeByIdWithProducts(schemeId: number): Promise<Static<typeof SchemeWithProductsSchema> | null> {
    const db = getDb();
    try {
        const schemeRaw = await db('schemes').where({ id: schemeId }).first();
        if (!schemeRaw) {
            return null;
        }

        const scheme: Static<typeof SchemeSchema> = {
            id: schemeRaw.id,
            name: schemeRaw.name,
            start_date: new Date(schemeRaw.start_date).toISOString().split('T')[0],
            end_date: new Date(schemeRaw.end_date).toISOString().split('T')[0],
            min_products_required: schemeRaw.min_products_required,
            is_active: Boolean(schemeRaw.is_active),
            description: schemeRaw.description,
            created_at: formatDbDate(schemeRaw.created_at),
            updated_at: formatDbDate(schemeRaw.updated_at)
        };

        const productsRaw = await db('scheme_products as sp')
            .join('products as p', 'sp.product_id', 'p.id')
            .where('sp.scheme_id', schemeId)
            .select(
                'sp.id',
                'sp.product_id',
                'sp.scheme_id',
                'p.name as product_name',
                'sp.quantity',
                'sp.is_mandatory',
                'sp.is_excluded'
            );

        const products = productsRaw.map(p => ({
            id: p.id, // This is scheme_products.id
            product_id: p.product_id,
            scheme_id: p.scheme_id,
            product_name: p.product_name,
            quantity: p.quantity,
            is_mandatory: Boolean(p.is_mandatory),
            is_excluded: Boolean(p.is_excluded)
        }));

        return { scheme, products };
    } catch (dbError: any) {
        console.error(`[DB Error] Failed to retrieve scheme ${schemeId} with products:`, dbError);
        throw new InternalServerError("Failed to retrieve scheme details due to a database issue.");
    }
}

async function crud_createScheme(
    schemeData: Static<typeof SchemeCreateSchema>,
    productRequirements: Static<typeof SchemeProductRequirementSchema>[],
    actingAdminIdentifier: string

): Promise<Static<typeof SchemeWithProductsSchema>> {
    const db = getDb();
    cmdLog(`🎁 Scheme creation attempt - Name: ${schemeData.name}`);
    cmdLog('Scheme creation input data', { schemeData, productRequirements, actingAdminIdentifier });

    if (new Date(schemeData.end_date) < new Date(schemeData.start_date)) {
        throw new ValidationError('Scheme Validation', undefined as any, 'End date cannot be before start date.');
    }

    let schemeId: number | undefined;
    try {
        await db.transaction(async trx => {
            cmdLog('Inserting scheme into DB', { schemeData });
            const [newSchemeIdResult] = await trx('schemes').insert({
                name: schemeData.name,
                start_date: schemeData.start_date,
                end_date: schemeData.end_date,
                min_products_required: schemeData.min_products_required,
                is_active: schemeData.is_active === undefined ? true : schemeData.is_active,
                description: schemeData.description,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }).returning('id');

            schemeId = typeof newSchemeIdResult === 'object' ? newSchemeIdResult.id : newSchemeIdResult;
            if (!schemeId) throw new InternalServerError('Scheme insert failed: No ID returned');

            // Insert scheme products if any
            if (productRequirements && productRequirements.length > 0) {
                const productIds = productRequirements.map(pr => pr.product_id);
                const existingProducts = await trx('products').whereIn('id', productIds).select('id');
                
                if (existingProducts.length !== productIds.length) {
                    const missingProductIds = productIds.filter(pid => 
                        !existingProducts.some(ep => ep.id === pid)
                    );
                    throw new NotFoundError(`One or more products not found: ${missingProductIds.join(', ')}`);
                }
                
                const schemeProductsData = productRequirements.map(pr => ({
                    scheme_id: schemeId,
                    product_id: pr.product_id,
                    quantity: pr.quantity,
                    is_mandatory: pr.is_mandatory === undefined ? false : pr.is_mandatory,
                    is_excluded: pr.is_excluded === undefined ? false : pr.is_excluded,
                               }));
                
                await trx('scheme_products').insert(schemeProductsData);
            }

            await crud_log_action(actingAdminIdentifier, 'create_scheme', 'Scheme', schemeId, { ...schemeData, products: productRequirements });
        });

        const newSchemeDetails = await crud_getSchemeByIdWithProducts(schemeId);
        if (!newSchemeDetails) {
            throw new InternalServerError('Could not fetch details of the newly created scheme.');
        }
        cmdLog(`✅ Scheme created successfully - ID: ${schemeId}`);
        return newSchemeDetails;

    } catch (error: any) {
        cmdLog(`❌ Scheme creation failed - Name: ${schemeData.name}, Error: ${error.message}`);
        cmdLog('Scheme creation error object', error);
        if (error instanceof NotFoundError || error instanceof ValidationError || error instanceof InternalServerError) {
            throw error;
        }
        if (error.message && error.message.includes('UNIQUE constraint failed: schemes.name')) {
             throw new ValidationError('Scheme Validation', undefined as any, 'A scheme with this name already exists.');
        }
        console.error(`[crud_createScheme] Error for ${schemeData.name}:`, error);
        throw new InternalServerError(`Database error during scheme creation: ${error.message || 'Unknown DB Error'}`);
    }
}

async function crud_updateScheme(
    schemeId: number,
    updateData: Static<typeof SchemeUpdateSchema>,
    productRequirements: Static<typeof SchemeProductRequirementSchema>[] | undefined, // Allow updating products too
    actingAdminIdentifier: string
): Promise<Static<typeof SchemeWithProductsSchema>> {
    const db = getDb();
    cmdLog(`🎁 Scheme update attempt - ID: ${schemeId}`);

    const scheme = await db('schemes').where({ id: schemeId }).first();
    if (!scheme) {
        throw new NotFoundError('Scheme not found.');
    }

    if (updateData.start_date && updateData.end_date && new Date(updateData.end_date) < new Date(updateData.start_date)) {
        throw new ValidationError('Scheme Validation', undefined as any, 'End date cannot be before start date.');
    } else if (updateData.start_date && !updateData.end_date && new Date(scheme.end_date) < new Date(updateData.start_date)) {
         throw new ValidationError('Scheme Validation', undefined as any, 'End date cannot be before start date.');
    } else if (!updateData.start_date && updateData.end_date && new Date(updateData.end_date) < new Date(scheme.start_date)) {
         throw new ValidationError('Scheme Validation', undefined as any, 'End date cannot be before start date.');
    }


    try {
        await db.transaction(async trx => {
            const schemeUpdatePayload: Record<string, any> = {};
            if (updateData.name !== undefined) schemeUpdatePayload.name = updateData.name;
            if (updateData.start_date !== undefined) schemeUpdatePayload.start_date = updateData.start_date;
            if (updateData.end_date !== undefined) schemeUpdatePayload.end_date = updateData.end_date;
            if (updateData.min_products_required !== undefined) schemeUpdatePayload.min_products_required = updateData.min_products_required;
            if (updateData.is_active !== undefined) schemeUpdatePayload.is_active = updateData.is_active;
            if (updateData.description !== undefined) schemeUpdatePayload.description = updateData.description;

            if (Object.keys(schemeUpdatePayload).length > 0) {
                schemeUpdatePayload.updated_at = new Date().toISOString();
                await trx('schemes').where({ id: schemeId }).update(schemeUpdatePayload);
            }

            if (productRequirements !== undefined) {
                // Delete existing products and replace with new ones
                await trx('scheme_products').where({ scheme_id: schemeId }).del();
                
                if (productRequirements.length > 0) {
                    const productIds = productRequirements.map(pr => pr.product_id);
                    const existingProducts = await trx('products').whereIn('id', productIds).select('id');
                    
                    if (existingProducts.length !== productIds.length) {
                        const missingProductIds = productIds.filter(pid => 
                            !existingProducts.some(ep => ep.id === pid)
                        );
                        throw new NotFoundError(`One or more products not found: ${missingProductIds.join(', ')}`);
                    }
                    
                    const schemeProductsData = productRequirements.map(pr => ({
                        scheme_id: schemeId,
                        product_id: pr.product_id,
                        quantity: pr.quantity,
                        is_mandatory: pr.is_mandatory === undefined ? false : pr.is_mandatory,
                        is_excluded: pr.is_excluded === undefined ? false : pr.is_excluded,
                    }));
                    
                    await trx('scheme_products').insert(schemeProductsData);
                }
            }
            await crud_log_action(actingAdminIdentifier, 'update_scheme', 'Scheme', schemeId, { ...updateData, products: productRequirements });
        });

        const updatedSchemeDetails = await crud_getSchemeByIdWithProducts(schemeId);
        if (!updatedSchemeDetails) {
            throw new InternalServerError('Could not fetch updated scheme with products.');
        }
        cmdLog(`✅ Scheme updated successfully - ID: ${schemeId}`);
        return updatedSchemeDetails;

    } catch (error: any) {
        cmdLog(`❌ Scheme update failed - ID: ${schemeId}, Error: ${error.message}`);
         if (error instanceof NotFoundError || error instanceof ValidationError || error instanceof InternalServerError) {
            throw error;
        }
        if (error.message && error.message.includes('UNIQUE constraint failed: schemes.name')) {
             throw new ValidationError('Scheme Validation', undefined as any, 'Another scheme with this name already exists.');
        }
        console.error(`[crud_updateScheme] Error for scheme ID ${schemeId}:`, error);
        throw new InternalServerError(`Database error during scheme update: ${error.message || 'Unknown DB Error'}`);
    }
}

async function crud_deleteScheme(schemeId: number, actingAdminIdentifier: string): Promise<Static<typeof SuccessStatusSchema>> {
    const db = getDb();
    cmdLog(`🗑️ Scheme delete attempt - ID: ${schemeId}`);

    try {
        // First check if scheme exists
        const scheme = await db('schemes').where({ id: schemeId }).first();
        if (!scheme) {
            throw new NotFoundError('Scheme not found.');
        }

        // Optimize deletion with better transaction setup and timeouts
        await db.transaction(async trx => {
            try {
                // Delete scheme products first (with explicit timeout control)
                await trx.raw('PRAGMA busy_timeout = 10000;'); // 10 second timeout specifically for this transaction
                
                // Delete scheme products in chunks to avoid locking the database for too long
                const schemeProducts = await trx('scheme_products').where({ scheme_id: schemeId }).select('id');
                const chunkSize = 5;
                
                for (let i = 0; i < schemeProducts.length; i += chunkSize) {
                    const chunk = schemeProducts.slice(i, i + chunkSize);
                    const ids = chunk.map(p => p.id);
                    await trx('scheme_products').whereIn('id', ids).delete();
                }
                
                // Then delete the scheme itself
                await trx('schemes').where({ id: schemeId }).delete();
                
                // Log success (but don't wait for it to complete)
                trx.on('query-response', () => {
                    // This runs after transaction commits
                    crud_log_action(actingAdminIdentifier, 'delete_scheme', 'Scheme', schemeId, { 
                        name: scheme.name,
                        deletion_time: new Date().toISOString()
                    }).catch(err => {
                        console.error(`[DB] Error logging scheme deletion for ID ${schemeId}:`, err);
                    });
                });
            } catch (txError) {
                console.error(`[Transaction Error] Scheme deletion failed for ID ${schemeId}:`, txError);
                throw txError;
            }
        });
        
        cmdLog(`✅ Scheme deleted successfully - ID: ${schemeId}`);
        return { success: true, message: 'Scheme deleted successfully.' };
    } catch (error: any) {
        cmdLog(`❌ Scheme delete failed - ID: ${schemeId}, Error: ${error.message}`);
        
        if (error instanceof NotFoundError || error instanceof InternalServerError) {
            throw error;
        }
        
        console.error(`[crud_deleteScheme] Error for scheme ID ${schemeId}:`, error);
        throw new InternalServerError(`Database error during scheme deletion: ${error.message || 'Unknown DB Error'}`);
    }
}

// ==============================================================================
// 8. Elysia App Instance & Plugins Setup
// ==============================================================================
const app = new Elysia()
    .onError(({ code, error, set, request }) => {
        const path = request ? `${request.method} ${request.url}` : 'Unknown route';
        const err = error as any;
        let status = 500;
        let responseBody: { message: string; errors?: any; name?: string } = { message: 'An internal server error occurred.' };

        console.error(`[ErrorHandler] Request: ${path} | Elysia Code: ${code}`);
        console.error(`[ErrorHandler] Error Type: ${typeof err}`);
        if (typeof err === 'object' && err !== null) {
            console.error(`[ErrorHandler] Error Name: ${err.name}`);
            console.error(`[ErrorHandler] Error Keys: ${Object.keys(err)}`);
        }

        try {
            const errorMessage = (typeof err?.message === 'string') ? err.message : (typeof err?.response === 'string') ? err.response : 'Unknown error reason';
            responseBody.message = errorMessage;
            if (err?.name) responseBody.name = err.name;

            if (err instanceof NotFoundError) {
                status = 404;
            } else if (err instanceof ParseError) {
                status = 400;
                responseBody.message = `Parsing Error: ${errorMessage}`;
            } else if (err instanceof ValidationError) {
                status = 422;
                responseBody.message = `Validation Error: ${errorMessage}`;
                responseBody.errors = err.all;
                console.error("[ErrorHandler] Validation Errors:", JSON.stringify(err.all, null, 2));
            } else if (typeof err === 'object' && err !== null) {
                if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
                    status = err.status;
                } else if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
                    status = err.statusCode;
                }
                if (responseBody.message === 'Unknown error reason' && status !== 500) {
                     responseBody.message = `Request failed with status ${status}`;
                }
            } else if (typeof err === 'string') {
                responseBody.message = err;
            } else {
                console.error("[ErrorHandler] Unknown Error Type:", err);
            }

            if ((code === 'INTERNAL_SERVER_ERROR' || code === 'UNKNOWN') && err?.stack) {
                console.error("[ErrorHandler] Stack Trace:", err.stack);
            }
        } catch (processingError: any) {
            console.error("!!! CRITICAL: Error within onError handler !!!", processingError);
            set.status = 500;
            return { message: 'Internal server error processing failed.' };
        }

        set.status = status;
        return responseBody;
    })
    .use(cors())
    .decorate('db', getDb())
    .decorate('config', { CONFIG_ADMIN_USERNAME, CONFIG_ADMIN_PASSWORD_PLAINTEXT, DEFAULT_SALESPERSON_ID });

// ==============================================================================
// 9. API Routes
// ==============================================================================

// --- General & Static Routes ---
app.get('/', () => ({ message: "Welcome - Bun/Elysia Version (Simulated Auth)" }), { response: MessageSchema, detail: { tags: ['General'] } });
app.get('/health', async ({ db, error }) => { try { await db.raw('SELECT 1'); return { message: 'API Healthy: DB OK' }; } catch (err) { console.error("Health check DB fail:", err); throw error(503, 'Database connection failed'); } }, { response: MessageSchema, detail: { tags: ['General'] } });
app.get(`${STATIC_ASSETS_ROUTE}/${BILL_UPLOAD_SUBDIR_NAME}/:filename`, async ({ params, error, set }) => { const filePath = path.join(BILL_UPLOAD_PATH, params.filename); try { const file = Bun.file(filePath); if (!(await file.exists())) throw new NotFoundError("Bill file not found."); const extension = path.extname(params.filename).toLowerCase(); let contentType = 'application/octet-stream'; if (extension === '.pdf') contentType = 'application/pdf'; else if (['.jpg', '.jpeg'].includes(extension)) contentType = 'image/jpeg'; else if (extension === '.png') contentType = 'image/png'; set.headers['Content-Type'] = contentType; return file; } catch (e: any) { if (e instanceof NotFoundError) throw e; console.error(`Error serving bill file ${params.filename}:`, e); throw new InternalServerError("Could not retrieve bill file."); } }, { params: t.Object({ filename: t.String() }), detail: { tags: ['File Access'] } });
app.get(`${STATIC_ASSETS_ROUTE}/${BANNER_UPLOAD_SUBDIR_NAME}/:filename`, async ({ params, error, set }) => { const filePath = path.join(BANNER_UPLOAD_PATH, params.filename); try { const file = Bun.file(filePath); if (!(await file.exists())) throw new NotFoundError("Banner image not found."); const extension = path.extname(params.filename).toLowerCase(); let contentType = 'image/webp'; if (['.jpg', '.jpeg'].includes(extension)) contentType = 'image/jpeg'; else if (extension === '.png') contentType = 'image/png'; else if (extension === '.gif') contentType = 'image/gif'; set.headers['Content-Type'] = contentType; return file; } catch (e: any) { if (e instanceof NotFoundError) throw e; console.error(`Error serving banner image ${params.filename}:`, e); throw new InternalServerError("Could not retrieve banner image."); } }, { params: t.Object({ filename: t.String() }), detail: { tags: ['File Access'] } });

// --- Dashboard API Routes (Individual Endpoints) ---
app.get('/api/admin/dashboard/users/count', async ({ db }) => {
    const countResult = await db('users').count({ count: '*' }).first();
    const count = Number(countResult?.count || 0);
    return { count };
}, { response: t.Object({ count: t.Integer() }), detail: { tags: ['Dashboard'] } });

app.get('/api/admin/dashboard/salespersons/count', async ({ db }) => {
    const countResult = await db('salespersons').count({ count: '*' }).first();
    const count = Number(countResult?.count || 0);
    return { count };
}, { response: t.Object({ count: t.Integer() }), detail: { tags: ['Dashboard'] } });

app.get('/api/admin/dashboard/products/stats', async ({ db }) => {
    // Get total products count
    const productCountResult = await db('products').count({ count: '*' }).first();
    const productCount = Number(productCountResult?.count || 0);
    
    // Get serial numbers stats
    const serialsResult = await db('serialnumbers')
        .select(
            db.raw('COUNT(*) as total_uploaded'),
            db.raw('SUM(CASE WHEN status = "registered" THEN 1 ELSE 0 END) as registeredSerials')
        )
        .first();
        
    const totalSerials = Number(serialsResult?.total_uploaded || 0);
    const registeredSerials = Number(serialsResult?.registeredSerials || 0);
    
    // Find the top product by number of serial registrations
    let topProduct = { name: 'None', serialCount: 0 };
    
    if (productCount > 0) {
        const topProductResult = await db('serialnumbers as sn')
            .leftJoin('products as p', 'sn.product_id', 'p.id')
            .where('sn.status', 'registered')
            .select('p.name', db.raw('COUNT(*) as serialCount'))
            .groupBy('sn.product_id')
            .orderBy('serialCount', 'desc')
            .first();
            
        if (topProductResult) {
            topProduct = {
                name: topProductResult.name || 'Unknown Product',
                serialCount: Number(topProductResult.serialCount || 0)
            };
        }
    }
    
    return {
        productCount,
        totalSerials,
        registeredSerials,
        topProduct
    };
}, { response: t.Object({
    productCount: t.Integer(),
    totalSerials: t.Integer(),
    registeredSerials: t.Integer(),
    topProduct: t.Object({
        name: t.String(),
        serialCount: t.Integer()
    })
}), detail: { tags: ['Dashboard'] } });
    
app.get('/api/admin/dashboard/recent_registrations', async ({ query }) => {
    const limit = Number(query.limit || 5);
    const recentRegistrations = await getDb()('serialnumbers as sn')
        .leftJoin('products as p', 'sn.product_id', 'p.id')
        .leftJoin('users as u', 'sn.user_id', 'u.id')
        .where('sn.status', 'registered')
        .select(
            'sn.serial_number',
            'sn.registration_date',
            'p.name as product_name',
            'u.company_name as registered_by'
        )
        .orderBy('sn.registration_date', 'desc')
        .limit(limit);
        
    return recentRegistrations.map(reg => ({
        serial_number: reg.serial_number,
        registration_date: formatDbDate(reg.registration_date),
        product_name: reg.product_name,
        registered_by: reg.registered_by || 'Unknown'
    }));
}, { query: t.Object({ limit: t.Optional(t.Numeric({ default: 5 })) }), 
     response: t.Array(t.Object({
         serial_number: t.String(),
         registration_date: t.String(),
         product_name: t.Optional(t.Nullable(t.String())),
         registered_by: t.String()
     })), 
     detail: { tags: ['Dashboard'] } });
    
app.get('/api/admin/dashboard/audit-logs/recent', async ({ query }) => {
    const limit = Number(query.limit || 5);
    const logs = await getDb()('audit_logs')
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .select('*');
        
    return logs.map(log => ({
        id: log.id,
        timestamp: formatDbDate(log.timestamp),
        admin_username: log.admin_username,
        sales_person_username: log.sales_person_username,
        acting_identifier: log.acting_identifier,
        action: log.action,
        target_type: log.target_type,
        target_id: log.target_id,
        details: typeof log.details === 'string' ? log.details : null
    }));
}, { query: t.Object({ limit: t.Optional(t.Numeric({ default: 5 })) }), 
     response: t.Array(AuditLogSchema), 
     detail: { tags: ['Dashboard'] } });


app.get('/admin/settings/dashboard_message', async ({ db }) => {
    try {
        const setting = await db('settings').where({ key: 'dashboard_message' }).first();
        return setting || { key: 'dashboard_message', value: 'Welcome to the admin dashboard!' };
    } catch (error) {
        console.error('Error fetching dashboard message:', error);
        return { key: 'dashboard_message', value: 'Welcome to the admin dashboard!' };
    }
}, { response: SettingSchema, detail: { tags: ['Dashboard'] } });

// --- Public User/Check Routes ---
app.group('/users', (group) => group
    .get('/check_mobile/:mobile', async ({ params }) => ({ exists: !!(await crud_findUserByMobile(params.mobile)) }), { params: t.Object({ mobile: t.String() }), response: ExistsCheckSchema, detail: { tags: ['User Checks'] } })
    .get('/check_gst/:gst', async ({ params }) => ({ exists: await crud_checkGstExists(params.gst) }), { params: t.Object({ gst: t.String() }), response: ExistsCheckSchema, detail: { tags: ['User Checks'] } })
    .get('/check_pan/:pan', async ({ params }) => ({ exists: await crud_checkPanExists(params.pan) }), { params: t.Object({ pan: t.String() }), response: ExistsCheckSchema, detail: { tags: ['User Checks'] } })
    .post('/signup', async ({ body, set }) => {
        const newUserWithDetails = await crud_createUser(body);
        set.status = 201;
        return { success: true, userId: newUserWithDetails.id };
    }, { body: UserBaseSchema, response: { 201: SignupResponseSchema, 409: MessageSchema, 422: MessageSchema, 404: MessageSchema, 500: MessageSchema }, detail: { tags: ['User Authentication'] } })
    .post('/token', async ({ body, set }) => {
        const { mobile_number } = body;
        cmdLog(`🔑 User login attempt - Mobile: ${mobile_number}`);
        
        const limitCheck = checkRateLimit(mobile_number);
        if (!limitCheck.allowed) { 
            cmdLog(`🚫 Login rate limit exceeded - Mobile: ${mobile_number}`);
           
            set.status = 429; 
            set.headers['Retry-After'] = String(limitCheck.retryAfter || 1); 
            return { message: 'Too many login attempts.' }; 
        }
        
        try {
            const user = await crud_findUserByMobile(mobile_number);
            if (!user) { 
                cmdLog(`❌ Login failed - Mobile not registered: ${mobile_number}`);
                set.status = 401; 
                return { message: 'Mobile number not registered.' }; 
            }
            if (!user.is_active) { 
                cmdLog(`❌ Login failed - User inactive: ${mobile_number} (ID: ${user.id})`);
                set.status = 403; 
                return { message: 'User account is inactive.'}; 
            }
            
            await crud_log_action(null, 'user_login_attempt_success', 'User', user.id);
            cmdLog(`✅ Login successful - User ID: ${user.id}, Mobile: ${mobile_number}`);
            return { 
                success: true, 
                message: 'Login successful', 
                userId: user.id, 
                can_register_serials: Boolean(user.can_register_serials) 
            };
        } catch (err: any) {
            await crud_log_action(null, 'user_login_attempt_failed');
            if (!(err.status && err.status >= 400 && err.status < 500)) { 
                console.error("User Login Error:", err); 
            }
            cmdLog(`❌ Login failed with server error - Mobile: ${mobile_number}`);
            throw new InternalServerError('Server error during login.');
        }
    }, { body: LoginRequestSchema, response: { 200: t.Object({ success: t.Boolean(), message: t.String(), userId: t.Numeric(), can_register_serials: t.Boolean() }), 401: MessageSchema, 403: MessageSchema, 429: MessageSchema, 500: MessageSchema }, detail: { tags: ['User Authentication'] } })
    .post('/:userId/serials/register', async({ params, body, set }) => {
        const { serial_number, bill_file } = body;
        const actingUserIdentifier = `user_id:${params.userId}`;
        const billFilename = await saveUploadFile(bill_file, BILL_UPLOAD_PATH, `bill_${params.userId}_`, ALLOWED_BILL_EXTENSIONS, MAX_FILE_SIZE_BYTES);
        try {
            const registeredSerial = await crud_register_serial_for_user(params.userId, serial_number, billFilename, actingUserIdentifier);
            set.status = 201;
            return registeredSerial;
        } catch (error) {
            await deleteUploadedFile(billFilename, BILL_UPLOAD_PATH);
            throw error;
        }
    }, { params: t.Object({ userId: t.Numeric() }), body: UserSerialRegistrationSchema, response: { 201: SerialNumberSchema, 400: MessageSchema, 403: MessageSchema, 404: MessageSchema, 409: MessageSchema, 413: MessageSchema, 422: MessageSchema, 500: MessageSchema }, detail: { tags: ['User Serials'] } })
    .get('/:userId/serials', async({ params }) => {
        return await crud_get_serials_by_user(params.userId);
    }, { params: t.Object({ userId: t.Numeric() }), response: t.Array(SerialNumberSchema), detail: { tags: ['User Serials'] } })
)

// --- Public Banner & Serial Routes (for mobile app) ---
app.group('/banners', (bannersGroup) => bannersGroup
    .get('/active', async ({ query }) => {
        // Return only active banners
        return crud_getBanners(query, true);
    }, { query: PaginationQuerySchema, response: t.Object({ banners: t.Array(BannerSchema), total: t.Integer(), skip: t.Integer(), limit: t.Integer() }), detail: { tags: ['Public Banners'] } })
)

// --- Public Serial Routes ---
app.group('/serials', (serialsGroup) => serialsGroup
    .get('/:serialNumber', async ({ params, headers }) => {
        const serial = await crud_get_serial_by_number_with_details(params.serialNumber);
        if (!serial) throw new NotFoundError('Serial number not found');

        // Check if this is a user's own serial or admin/salesperson
        const authHeader = headers.authorization || '';
        const isAdmin = authHeader.startsWith('Bearer admin_');
        const isSalesPerson = authHeader.startsWith('Bearer sales_');
        const userId = Number(authHeader.replace('Bearer user_', ''));
        
        // If normal user, check if serial belongs to them
        const isOwnedByUser = !isNaN(userId) && userId > 0 && serial.user_id === userId;
        
        // If not admin/salesperson and not owned by requesting user, hide product details
        if (!isAdmin && !isSalesPerson && !isOwnedByUser) {
            return {
                serial_number: serial.serial_number,
                product_name: "Product", // Hide actual product name
                product_description: null,
                status: serial.status
            };
        }
        
        // Otherwise return full details
        return {
            serial_number: serial.serial_number,
            product_name: serial.product_name,
            product_description: null, // You can enhance this by joining with product description if needed
            status: serial.status
        };
    }, { params: t.Object({ serialNumber: t.String() }), response: ProductDetailFetchSchema, detail: { tags: ['Public Serials'] } })
);

// --- Admin Routes ---
app.group('/admin', (adminGroup) => adminGroup
    .post('/token', async ({ body, config, set }) => {
        cmdLog(`🔐 Admin login attempt - Username: ${body.username}`);
        if (body.username === config.CONFIG_ADMIN_USERNAME && body.password === config.CONFIG_ADMIN_PASSWORD_PLAINTEXT) {
            await crud_log_action(config.CONFIG_ADMIN_USERNAME, 'admin_login_success');
            cmdLog(`✅ Admin login successful - Username: ${body.username}`);
            return { success: true, message: 'Admin login successful' };
        } else {
            await crud_log_action(body.username, 'admin_login_failed');
            cmdLog(`❌ Admin login failed - Username: ${body.username}`);
            set.status = 401;
            return { message: 'Invalid admin credentials' };
        }
    }, { body: AdminLoginRequestSchema, response: { 200: SuccessStatusSchema, 401: MessageSchema }, detail: { tags: ['Admin Authentication'] } })
    // Admin Product Management
    .group('/products', (productGroup) => productGroup
        .post('/', async ({ body, config, set }) => {
            const newProduct = await crud_createProduct(body, config.CONFIG_ADMIN_USERNAME);
            set.status = 201;
            return newProduct;
        }, { body: ProductCreateSchema, response: { 201: ProductCreateResponseSchema, 500: MessageSchema }, detail: { tags: ['Admin Products'] } })
        .get('/', async ({ query }) => {
            return await crud_getProductsWithInventory(query?.skip, query?.limit);
        }, { query: PaginationQuerySchema, response: t.Array(ProductSchema), detail: { tags: ['Admin Products'] } })
                                                         .get('/:productId', async ({ params, error }) => {
            const productId = Number(params?.productId);
            if (isNaN(productId)) throw error(400, 'Invalid Product ID');
            const product = await crud_getProductByIdWithInventory(productId);
            if (!product) throw new NotFoundError('Product not found');
            return product;
        }, { params: t.Object({ productId: t.Numeric() }), response: ProductSchema, detail: { tags: ['Admin Products'] } })
        .put('/:productId', async ({ params, body, config }) => {
            const actingIdentifier = config.CONFIG_ADMIN_USERNAME;
            const updatedProduct = await crud_update_product(params.productId, body, actingIdentifier);
            if (!updatedProduct) throw new NotFoundError('Product not found or no changes made.');
            return updatedProduct;
        }, { params: t.Object({ productId: t.Numeric() }), body: ProductUpdateSchema, response: ProductSchema, detail: { tags: ['Admin Products'] } })
        .delete('/:productId', async ({ params, config, set }) => {
            const success = await crud_delete_product(params.productId, config.CONFIG_ADMIN_USERNAME);
            if (success) {
                set.status = 200;
                return { message: `Product ${params.productId} deleted.` };
            }
            // If crud_delete_product throws, it will be handled by onError
            throw new InternalServerError("Failed to delete product due to an unexpected issue."); // Fallback
        }, { params: t.Object({ productId: t.Numeric() }), response: { 200: MessageSchema, 404: MessageSchema, 409: MessageSchema, 500: MessageSchema }, detail: { tags: ['Admin Products'] } })
        .post('/:productId/serials/upload', async ({ params, body, config, error, set }) => {
            const product = await crud_getProductById(params.productId);
            if (!product) throw new NotFoundError('Product not found for serial upload.');
            if (!isAllowedFile(body.file.name, ALLOWED_CSV_EXTENSIONS)) {
                throw error(400, `Invalid file type for serials. Allowed: ${Array.from(ALLOWED_CSV_EXTENSIONS).join(',')}`);
            }
            const serials = await parseCsvSerials(body.file);
            if (serials.length === 0) throw error(400, 'No serial numbers found in the uploaded file.');

            const result = await crud_add_serial_numbers(params.productId, serials, config.CONFIG_ADMIN_USERNAME);
            if (result.errors.length > 0) {
                set.status = result.added_count > 0 ? 207 : 409;
            } else if (result.duplicates_found.length > 0 && result.added_count === 0) {
                set.status = 409;
            } else {
                set.status = 201;
            }
            return result;
        }, { params: t.Object({ productId: t.Numeric() }), body: t.Object({ file: t.File({ maxSize: `${MAX_FILE_SIZE_MB}m` }) }), response: { 201: BulkAddSerialsResponseSchema, 207: BulkAddSerialsResponseSchema, 400: MessageSchema, 404: MessageSchema, 409: BulkAddSerialsResponseSchema, 413: MessageSchema, 422: MessageSchema, 500: MessageSchema }, detail: { tags: ['Admin Products'] } })
        .get('/:productId/serials', async ({ params, query }) => {
            const productId = Number(params.productId);
            if (isNaN(productId)) {
                throw { statusCode: 400, message: 'Invalid Product ID' };
            }
            
            // Extract pagination parameters from query
            const skip = Number(query?.skip ?? 0);
            const limit = Number(query?.limit ?? 50);
            
            // First check if the product exists
            const product = await crud_getProductById(productId);
            if (!product) throw new NotFoundError('Product not found');
            
            // Get serial numbers for this product with pagination
            return await crud_get_serials_by_product(productId, skip, limit);
        }, { params: t.Object({ productId: t.Numeric() }), query: PaginationQuerySchema, response: t.Array(SerialNumberSchema), detail: { tags: ['Admin Products'] } })
    )
     // Admin User Management
     .group('/users', (adminUserGroup) => adminUserGroup
        .get('/', async ({ query, db }) => {
            const skip = Number(query?.skip ?? 0); const limit = Number(query?.limit ?? 100);
            const usersRaw = await db('users')
                .leftJoin('salespersons', 'users.sales_person_id', 'salespersons.id')
                .select(
                    'users.id', 'users.mobile_number', 'users.company_name',
                    'users.gst_number', 'users.pan_number', 'users.is_active',
                    'users.can_register_serials', 'users.admin_note', 'users.sales_person_id',
                    'users.created_at', 'users.updated_at',
                    'salespersons.name as sales_person_name'
                )
                .offset(skip).limit(limit).orderBy('users.id', 'desc');

            const users: Static<typeof UserSchema>[] = usersRaw.map(u => ({
                id: u.id,
                mobile_number: u.mobile_number,
                company_name: u.company_name,
                sales_person_id: u.sales_person_id,
                gst_number: u.gst_number,
                pan_number: u.pan_number,
                is_active: Boolean(u.is_active),
                can_register_serials: Boolean(u.can_register_serials),
                admin_note: u.admin_note,
                sales_person_name: u.sales_person_name,
                created_at: formatDbDate(u.created_at),
                updated_at: formatDbDate(u.updated_at)
            }));
            const totalResult = await db('users').count({count: '*'}).first();
            const total = Number(totalResult?.count || 0);
            return { users, total, skip, limit };
        }, { query: PaginationQuerySchema, response: t.Object({ users: t.Array(UserSchema), total: t.Integer(), skip: t.Integer(), limit: t.Integer() }), detail: { tags: ['Admin Users'] } })
        .get('/:userId', async ({ params, error }) => {
            const user = await crud_getUserDetails(params.userId);
            if (!user) throw new NotFoundError('User not found');
            return user;
        }, { params: t.Object({ userId: t.Numeric() }), response: UserSchema, detail: { tags: ['Admin Users'] } })
        .put('/:userId', async ({ params, body, config }) => {
            const updatedUser = await crud_admin_update_user(params.userId, body, config.CONFIG_ADMIN_USERNAME);
            return updatedUser;
        }, { params: t.Object({ userId: t.Numeric() }), body: UserUpdateSchema, response: UserSchema, detail: { tags: ['Admin Users'] } })
        .delete('/:userId', async ({ params, query, config, set }) => {
            const hardDelete = query.hard_delete === true || query.hard_delete === 'true';
            const result = await crud_delete_user(params.userId, config.CONFIG_ADMIN_USERNAME, hardDelete);
            set.status = 200;
            return result;
        }, { params: t.Object({ userId: t.Numeric() }), query: t.Object({ hard_delete: t.Optional(t.Union([t.Boolean(), t.String()])) }), response: { 200: SuccessStatusSchema, 404: MessageSchema, 500: MessageSchema }, detail: { tags: ['Admin Users'] } })
        .get('/:userId/serials', async({ params }) => {
            return await crud_get_serials_by_user(params.userId);
        }, { params: t.Object({ userId: t.Numeric() }), response: t.Array(SerialNumberSchema), detail: { tags: ['Admin Users'] } })
        .delete('/:userId/serials/:serialNumber', async ({ params, config, set }) => {
            await crud_disassociate_serial(params.serialNumber, config.CONFIG_ADMIN_USERNAME);
            set.status = 200;
            return { message: `Serial ${params.serialNumber} disassociated from user ${params.userId}.` };
        }, { params: t.Object({ userId: t.Numeric(), serialNumber: t.String() }), response: { 200: MessageSchema, 400: MessageSchema, 404: MessageSchema, 500: MessageSchema }, detail: { tags: ['Admin Users'] } })
    )
    // Admin SalesPerson Management
    .group('/salespersons', (spGroup) => spGroup
        .post('/', async ({ body, config, set }) => {
            const newSalesPerson = await crud_createSalesPerson(body, config.CONFIG_ADMIN_USERNAME);
            set.status = 201;
            return newSalesPerson;
        }, { body: SalesPersonCreateSchema, response: { 201: SalesPersonSchema, 409: MessageSchema, 500: MessageSchema }, detail: { tags: ['Admin SalesPersons'] } })
        .get('/', async ({ query }) => {
            return await crud_getSalesPersons(query);
        }, { query: PaginationQuerySchema, response: t.Object({ salespersons: t.Array(SalesPersonSchema), total: t.Integer(), skip: t.Integer(), limit: t.Integer() }), detail: { tags: ['Admin SalesPersons'] } })
        .get('/:id', async ({ params }) => {
            return await crud_getSalesPersonById(params.id);
        }, { params: t.Object({ id: t.Numeric() }), response: SalesPersonSchema, detail: { tags: ['Admin SalesPersons'] } })
        .put('/:id', async ({ params, body, config }) => {
            return await crud_updateSalesPerson(params.id, body, config.CONFIG_ADMIN_USERNAME);
        }, { params: t.Object({ id: t.Numeric() }), body: SalesPersonUpdateSchema, response: SalesPersonSchema, detail: { tags: ['Admin SalesPersons'] } })
        .delete('/:id', async ({ params, config, set }) => {
            const result = await crud_deleteSalesPerson(params.id, config.CONFIG_ADMIN_USERNAME);
            set.status = 200;
            return result;
        }, { params: t.Object({ id: t.Numeric() }), response: { 200: SuccessStatusSchema, 404: MessageSchema, 409: MessageSchema, 400: MessageSchema, 500: MessageSchema }, detail: { tags: ['Admin SalesPersons'] } })
    )
    // Admin Banners Management
    .group('/banners', (bannerGroup) => bannerGroup
        .post('/', async ({ body, config, set }) => {
            const { image_file, ...bannerDataInput } = body;
            const is_active_bool = bannerDataInput.is_active === undefined ? true : bannerDataInput.is_active === 'true';
            const bannerData = {
                link_url: bannerDataInput.link_url,
                alt_text: bannerDataInput.alt_text,
                is_active: is_active_bool
             };
            const imageFilename = await saveUploadFile(image_file, BANNER_UPLOAD_PATH, 'banner_', ALLOWED_BANNER_EXTENSIONS, MAX_FILE_SIZE_BYTES);
            try {
                const newBanner = await crud_createBanner(bannerData, imageFilename, config.CONFIG_ADMIN_USERNAME);
                set.status = 201;
                return newBanner;
            } catch (dbError) {
                await deleteUploadedFile(imageFilename, BANNER_UPLOAD_PATH);
                throw dbError;
            }
        }, { body: BannerCreateBodySchema, response: { 201: BannerSchema, 400: MessageSchema, 413: MessageSchema, 422: MessageSchema, 500: MessageSchema }, detail: { tags: ['Admin Banners'] } })
        .get('/', async ({ query }) => {
            return crud_getBanners(query, false);
        }, { query: PaginationQuerySchema, response: t.Object({ banners: t.Array(BannerSchema), total: t.Integer(), skip: t.Integer(), limit: t.Integer() }), detail: { tags: ['Admin Banners'] } })
        .get('/:id', async ({ params, error }) => {
            const banner = await crud_getBannerById(params.id);
            if (!banner) throw new NotFoundError('Banner not found');
            return banner;
        }, { params: t.Object({ id: t.Numeric() }), response: BannerSchema, detail: { tags: ['Admin Banners'] } })
        .put('/:id', async ({ params, body, config }) => {
            const { image_file, ...bannerUpdateData } = body;
            let newImageFilename: string | null = null;
            if (image_file && image_file.size > 0) {
                newImageFilename = await saveUploadFile(image_file, BANNER_UPLOAD_PATH, 'banner_update_', ALLOWED_BANNER_EXTENSIONS, MAX_FILE_SIZE_BYTES);
            }
            try {
                const updatedBanner = await crud_updateBanner(params.id, bannerUpdateData, newImageFilename, config.CONFIG_ADMIN_USERNAME);
                return updatedBanner;
            } catch (dbError) {
                if (newImageFilename) {
                    await deleteUploadedFile(newImageFilename, BANNER_UPLOAD_PATH);
                }
                throw dbError;
            }
        }, { params: t.Object({ id: t.Numeric() }), body: BannerUpdateBodySchema, response: BannerSchema, detail: { tags: ['Admin Banners'] } })
        .delete('/:id', async ({ params, config }) => {
            return crud_deleteBanner(params.id, config.CONFIG_ADMIN_USERNAME);
        }, { params: t.Object({ id: t.Numeric() }), response: { 200: SuccessStatusSchema, 404: MessageSchema, 500: MessageSchema }, detail: { tags: ['Admin Banners'] } })
    )
    // Admin Settings Management
    .group('/settings', (settingsGroup) => settingsGroup
        .get('/', async({ query }) => {
            return crud_getAllSettings(query);
        }, { query: PaginationQuerySchema, response: t.Object({ settings: t.Array(SettingSchema), total: t.Integer(), skip: t.Integer(), limit: t.Integer() }), detail: { tags: ['Admin Settings'] } })
        .get('/:key', async ({ params }) => {
            return crud_getSetting(params.key);
        }, { params: t.Object({ key: t.String() }), response: SettingSchema, detail: { tags: ['Admin Settings'] } })
        .put('/:key', async ({ params, body, config }) => {
            return crud_setSetting(params.key, body.value, config.CONFIG_ADMIN_USERNAME);
        }, { params: t.Object({ key: t.String() }), body: SettingUpdateSchema, response: SettingSchema, detail: { tags: ['Admin Settings'] } })
    )
    // Admin Audit Log Viewing
    .get('/audit_logs', async ({ query }) => {
        return crud_get_audit_logs(query);
    }, { query: AuditLogQuerySchema, response: t.Object({ logs: t.Array(AuditLogSchema), total: t.Integer(), skip: t.Integer(), limit: t.Integer() }), detail: { tags: ['Admin Audit'] } })
    // Admin Bill Download
    .get('/serials/:serialNumber/bill', async ({ params, error, set }) => {
        const serialDetails = await crud_get_serial_by_number_with_details(params.serialNumber);
        if (!serialDetails || !serialDetails.bill_filename) {
            throw new NotFoundError('Bill file not found for this serial number or serial does not exist.');
        }
        const filePath = path.join(BILL_UPLOAD_PATH, serialDetails.bill_filename);
        try {
            const file = Bun.file(filePath);
            if (!(await file.exists())) throw new NotFoundError("Bill file not found on disk.");

            const extension = path.extname(serialDetails.bill_filename).toLowerCase();
            let contentType = 'application/octet-stream';
            if (extension === '.pdf') contentType = 'application/pdf';
            else if (['.jpg', '.jpeg'].includes(extension)) contentType = 'image/jpeg';
            else if (extension === '.png') contentType = 'image/png';

            set.headers['Content-Type'] = contentType;
            return file;
        } catch (e: any) {
            if (e instanceof NotFoundError) throw e;
            console.error(`Error serving bill file ${serialDetails.bill_filename}:`, e);
            throw new InternalServerError("Could not retrieve bill file.");
        }
    }, { params: t.Object({ serialNumber: t.String() }), detail: { tags: ['Admin Bills'] } })
    .group('/schemes', (schemeGroup) => schemeGroup
        .post('/', async ({ body, config, set }) => {
            const { products, ...schemeData } = body;
            
            // Validate dates
            if (new Date(schemeData.end_date) < new Date(schemeData.start_date)) {
                set.status = 422;
                return { message: 'End date cannot be before start date.' };
            }
            
            try {
                const newScheme = await crud_createScheme(schemeData, products || [], config.CONFIG_ADMIN_USERNAME);
                set.status = 201;
                return newScheme;
            } catch (error) {
                if (error instanceof ValidationError) {
                    set.status = 422;
                    return { message: error.message };
                }
                throw error;
            }
        }, { 
            body: SchemeCreateSchema, 
            response: { 
                201: SchemeWithProductsSchema, 
                400: MessageSchema, 
                404: MessageSchema, 
                409: MessageSchema,
                422: MessageSchema, 
                500: MessageSchema 
            }, 
            detail: { tags: ['Admin Schemes'] } 
        })
        .get('/', async ({ query }) => {
            return await crud_get_schemes(query);
        }, { 
            query: PaginationQuerySchema, 
            response: t.Object({ 
                schemes: t.Array(SchemeSchema), 
                total: t.Integer(), 
                skip: t.Integer(), 
                limit: t.Integer() 
            }), 
            detail: { tags: ['Admin Schemes'] } 
        })
        .get('/:schemeId', async ({ params, error }) => {
            const scheme = await crud_getSchemeByIdWithProducts(params.schemeId);
            if (!scheme) throw new NotFoundError('Scheme not found');
            return scheme;
        }, {
            params: t.Object({ schemeId: t.Numeric() }),
            response: { 200: SchemeWithProductsSchema, 404: MessageSchema },
            detail: { tags: ['Admin Schemes'] }
        })
        .put('/:schemeId', async ({ params, body, config }) => {
            const { products, ...schemeUpdateData } = body;
            const updatedScheme = await crud_updateScheme(params.schemeId, schemeUpdateData, products, config.CONFIG_ADMIN_USERNAME);
            return updatedScheme;
        }, {
            params: t.Object({ schemeId: t.Numeric() }),
            body: SchemeUpdateSchema,
            response: { 200: SchemeWithProductsSchema, 400: MessageSchema, 404: MessageSchema, 409: MessageSchema, 422: MessageSchema, 500: MessageSchema },
            detail: { tags: ['Admin Schemes'] }
        })
        .delete('/:schemeId', async ({ params, config, set }) => {
            const result = await crud_deleteScheme(params.schemeId, config.CONFIG_ADMIN_USERNAME);
            // No need to check result.success here as crud_deleteScheme throws on failure
            set.status = 200;
            return result;
        }, { 
            params: t.Object({ schemeId: t.Numeric() }), 
            response: { 200: SuccessStatusSchema, 404: MessageSchema, 500: MessageSchema }, 
            detail: { tags: ['Admin Schemes'] } 
        })
    )
    ) // closes the last .group (admin)
;

// Start the server
setupDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`[Server] Listening on http://localhost:${PORT}`);
    });
});