# Sotoayam

Backend internal dan web admin sederhana untuk registrasi pengguna Telegram serta routing notifikasi dari n8n. Business logic recipient berada di backend, sehingga n8n hanya mengirim event dan tidak menyimpan Telegram Chat ID.

## Architecture

```text
ERP (future)
  ↓
n8n
  ↓
Sotoayam
  ├── Supabase / PostgreSQL
  └── Telegram Bot API
```

Boundary ERP belum diimplementasikan pada MVP ini. Integrasi berikutnya masuk melalui event contract backend, bukan query database dari workflow n8n.

## Local Development dan Setup

Persyaratan: versi Node.js pada `.node-version` dan project Supabase.

1. Install dependency: `npm install`.
2. Salin nama variable dari `.env.example` ke `.env` milik lokal dan isi secret secara lokal. Jangan commit `.env`.
3. Hubungkan Supabase CLI ke project yang dituju dengan project ref milik operator, lalu jalankan seluruh migration terurut dengan `npm run migrate`.
4. Build aplikasi: `npm run build`.
5. Pilih mode setup secara eksplisit dan provision administrator pertama tepat sekali:
   - instalasi customer baru: `npm run setup -- --fresh-install --division-name "Operations" --division-code OPERATIONS`;
   - instalasi lama: `npm run setup -- --keep-existing-taxonomy --division-code EXISTING_DIVISION`.
   Pada mode fresh, setup membuat Divisi nyata pertama milik customer dan administrator pertama di dalam satu transaksi.
6. Setelah setup fresh, restart service bila sudah berjalan agar provenance baru dibaca. Untuk development lokal, jalankan `npm run dev`.
7. Buka `http://localhost:3000`.
8. Jalankan test: `npm test`; typecheck/build: `npm run typecheck` dan `npm run build`.

Environment wajib: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `INTERNAL_API_KEY`, dan `ADMIN_API_KEY` dengan panjang minimal 32 karakter. Untuk kompatibilitas instalasi lama, backend juga menerima alias `SUPABASE_SERVICE_KEY`, tetapi nama canonical yang dianjurkan adalah `SUPABASE_SERVICE_ROLE_KEY`.

Environment opsional: `PORT`, `TELEGRAM_POLLING_ENABLED`, dan `LOG_LEVEL`. Seluruh Admin API wajib menerima header `X-Admin-Api-Key`; tombol **Admin Key** pada UI menyimpannya hanya di `sessionStorage` tab browser.

## Legacy Compatibility Identifiers

Instalasi lama dapat memiliki nama teknis yang sudah menjadi kontrak deployment atau data persisten: path `/opt/gwens-automation`, unit `gwens-automation.service`, akun/grup sistem `gwens`, project ID Supabase lokal `gwensoto`, key browser `gwens-admin-key`, contract ID `GWENS_LEGACY_SCHEMA_V1`, serta advisory-lock key `gwens_*` di migration historis. Jangan mengubahnya tanpa migrasi deployment, browser state, dan database yang terkoordinasi. Identifier tersebut hanya untuk kompatibilitas; identitas produk resminya adalah Sotoayam, dan identifier project lokal tidak disertakan dalam release archive customer.

Telegram polling memakai `getUpdates`. Jangan jalankan lebih dari satu instance polling dengan token yang sama. Set `TELEGRAM_POLLING_ENABLED=false` pada instance tambahan atau saat memakai integrasi lain.

## Telegram Registration

```text
User → /start → upsert telegram_chat_id → database → Admin activation
```

Registrasi pertama membuat user `UNASSIGNED` dan inactive. `/start` berikutnya hanya menyegarkan username/first name Telegram; Divisi, Role, status aktif, dan preferensi notifikasi tidak di-reset.

## Admin API

- `GET /health` — liveness check tanpa informasi credential.
- `GET /api/users` — list user; menerima `status=pending|active|inactive`, `division=<Divisi>`, dan `active=true|false`.
- `GET /api/users/:id` — detail user.
- `PATCH /api/users/:id` — ubah Nama, Divisi, Role, status, dan preference. `telegram_chat_id` tidak dapat diubah dari endpoint ini.

## Notification Flow dan Kontrak n8n

```text
n8n event → POST API → recipient resolver → active + preference → Telegram
```

Request:

```http
POST /api/notifications/send
Content-Type: application/json
X-Internal-Api-Key: <credential yang disimpan di n8n>
```

```json
{
  "event_id": "stock-SKU001-20260826-001",
  "type": "STOCK_CRITICAL",
  "message": "Stok SKU001 mencapai batas kritis.",
  "metadata": { "sku": "SKU001" }
}
```

Jika `event_id` disertakan, kombinasi source dan event ID disimpan sebagai kunci idempotency: retry dengan payload identik mengembalikan hasil tersimpan tanpa broadcast ulang, sedangkan penggunaan ulang dengan payload berbeda ditolak dengan `409 NOTIFICATION_EVENT_CONFLICT`. Request tanpa `event_id` tetap didukung sebagai alur legacy non-idempotent. n8n tidak perlu mengetahui recipient maupun Telegram Chat ID.

Mapping event:

| Event | Preference |
|---|---|
| `STOCK_CRITICAL` | `stock_alert` |
| `PURCHASE_RECOMMENDATION` | `purchase_alert` |
| `SALES_FOLLOWUP` | `sales_alert` |
| `MARKETING_ALERT` | `marketing_alert` |
| `CONTENT_OPPORTUNITY` | `content_alert` |
| `OWNER_DAILY_REPORT` | `owner_report` |
| `SYSTEM_ERROR` | `system_error` |

Pengiriman memakai `Promise.allSettled`, jadi kegagalan satu recipient tidak membatalkan recipient lain.

## Security Notes

- Supabase service role key dan Telegram token hanya digunakan server-side.
- Notification endpoint selalu dilindungi shared secret dengan perbandingan constant-time berbasis digest.
- RLS diaktifkan pada tabel tanpa policy client; akses data dilakukan backend service role.
- Error response tidak mengirim stack trace atau environment value.
- `ADMIN_API_KEY` adalah proteksi MVP. Upgrade yang disarankan sebelum production adalah identity-based admin authentication, audit log, rate limiting, dan secret rotation.
