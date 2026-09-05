# Gwens Automation Control

Backend internal dan web admin sederhana untuk registrasi pengguna Telegram serta routing notifikasi dari n8n. Business logic recipient berada di backend, sehingga n8n hanya mengirim event dan tidak menyimpan Telegram Chat ID.

## Architecture

```text
ERP (future)
  ↓
n8n
  ↓
Gwens Automation Control
  ├── Supabase / PostgreSQL
  └── Telegram Bot API
```

Boundary ERP belum diimplementasikan pada MVP ini. Integrasi berikutnya masuk melalui event contract backend, bukan query database dari workflow n8n.

## Local Development

Persyaratan: Node.js 20+ dan project Supabase.

1. Install dependency: `npm install`.
2. Salin nama variable dari `.env.example` ke `.env` milik lokal dan isi secret secara lokal. Jangan commit `.env`.
3. Login dan link Supabase CLI ke project yang benar, lalu terapkan **seluruh** migration berurutan dengan `npx supabase db push`. Jangan menjalankan hanya satu file SQL; aplikasi memerlukan seluruh katalog identity, task, governance, reminder, dan integrasi di `supabase/migrations/`.
4. Jalankan `npm run check:migration-baseline` setelah konfigurasi credential Supabase tersedia. Pemeriksaan ini memverifikasi kontrak migrasi dan konektivitas; jangan menaruh credential di command, dokumentasi, atau Git.
5. Jalankan development server: `npm run dev`.
6. Buka `http://localhost:3000`.
7. Jalankan test: `npm test`; typecheck/build: `npm run typecheck` dan `npm run build`.

Environment wajib: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, dan `INTERNAL_API_KEY`. Untuk kompatibilitas workspace lama, backend juga menerima alias `SUPABASE_SERVICE_KEY`, tetapi nama canonical yang dianjurkan adalah `SUPABASE_SERVICE_ROLE_KEY`.

Environment opsional: `PORT`, `TELEGRAM_POLLING_ENABLED`, `LOG_LEVEL`, dan `ADMIN_API_KEY`. Jika `ADMIN_API_KEY` diisi, seluruh `/api/users` wajib menerima header `X-Admin-Api-Key`; tombol **Admin Key** pada UI menyimpannya hanya di `sessionStorage` tab browser. Jika tidak diisi, API admin bersifat public dan deployment tidak boleh dianggap production-ready.

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
  "event_id": "stock-SQ001-20260826-001",
  "type": "STOCK_CRITICAL",
  "message": "Stok Squishy Strawberry kritis.",
  "metadata": { "sku": "SQ001" }
}
```

`event_id` diterima untuk forward compatibility. n8n tidak perlu mengetahui recipient maupun Telegram Chat ID.

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
