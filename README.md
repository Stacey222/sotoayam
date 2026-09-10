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
3. Build aplikasi: `npm run build`. Perintah migrasi memakai runner hasil build.
4. Hubungkan Supabase CLI ke project yang dituju dengan project ref milik operator, lalu jalankan seluruh migration terurut dengan `npm run migrate`.
5. Pilih mode setup secara eksplisit dan provision administrator pertama tepat sekali:
   - instalasi customer baru: `npm run setup -- --fresh-install --division-name "Operations" --division-code OPERATIONS`;
   - instalasi lama: `npm run setup -- --keep-existing-taxonomy --division-code EXISTING_DIVISION`.
   Pada mode fresh, setup membuat Divisi nyata pertama milik customer dan administrator pertama di dalam satu transaksi.
6. Setelah setup fresh, restart service bila sudah berjalan agar provenance baru dibaca. Untuk development lokal, jalankan `npm run dev`.
7. Buka `http://localhost:3000`, lalu masuk dengan email dan password administrator yang dibuat oleh setup. Untuk localhost HTTP saja, set `SESSION_COOKIE_SECURE=false` dengan `TRUST_PROXY=false`; cookie tidak aman ditolak pada host non-loopback atau saat proxy trust aktif.
8. Jalankan test: `npm test`; typecheck/build: `npm run typecheck` dan `npm run build`.

Environment wajib: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `INTERNAL_API_KEY`, dan `ADMIN_API_KEY` dengan panjang minimal 32 karakter. Untuk kompatibilitas instalasi lama, backend juga menerima alias `SUPABASE_SERVICE_KEY`, tetapi nama canonical yang dianjurkan adalah `SUPABASE_SERVICE_ROLE_KEY`.

Environment sesi opsional: `SESSION_ABSOLUTE_TTL_SECONDS` (default 12 jam), `SESSION_IDLE_TTL_SECONDS` (default 1 jam), `SESSION_COOKIE_SECURE` (default `true`), `TRUST_PROXY` (default `false`), dan `ADMIN_API_KEY_FALLBACK_ENABLED` (sementara default `true`). UI memakai cookie sesi `HttpOnly`, tidak pernah menerima atau menyimpan `ADMIN_API_KEY`, dan mengirim token CSRF pada perubahan data. Production wajib memakai HTTPS; aktifkan `TRUST_PROXY=true` hanya di belakang reverse proxy tepercaya.

Rate limiting aktif secara default dan berjalan dalam memori proses; counter kembali penuh saat restart. Konfigurasinya adalah `RATE_LIMIT_ENABLED`, `RATE_LIMIT_LOGIN_PER_MINUTE`, `RATE_LIMIT_LOGIN_GLOBAL_PER_MINUTE`, `RATE_LIMIT_ADMIN_READ_PER_MINUTE`, `RATE_LIMIT_ADMIN_WRITE_PER_MINUTE`, `RATE_LIMIT_ADMIN_EXPENSIVE_PER_MINUTE`, `RATE_LIMIT_INTERNAL_PER_MINUTE`, `RATE_LIMIT_AUTH_FAILURE_PER_MINUTE`, `RATE_LIMIT_SHARED_ORIGIN_FACTOR`, `RATE_LIMIT_MAX_KEYS`, dan allowlist exact-address `RATE_LIMIT_TRUSTED_IPS`; default tercantum di `.env.example` dan seluruh batas tercantum di panduan instalasi. Pemeriksaan password administrator tetap 5 per 15 menit dan pembacaan sesi tetap 120 per menit. Pada deployment reverse proxy, proxy harus menimpa `X-Forwarded-For` dan `TRUST_PROXY=true` hanya boleh digunakan di belakang proxy tersebut. `RATE_LIMIT_ENABLED=false` adalah kill switch operasional, bukan bypass autentikasi.

## Legacy Compatibility Identifiers

Instalasi lama dapat memiliki nama teknis yang sudah menjadi kontrak deployment atau data persisten: path `/opt/gwens-automation`, unit `gwens-automation.service`, akun/grup sistem `gwens`, project ID Supabase lokal `gwensoto`, contract ID `GWENS_LEGACY_SCHEMA_V1`, serta advisory-lock key `gwens_*` di migration historis. Jangan mengubahnya tanpa migrasi deployment dan database yang terkoordinasi. Penyimpanan browser legacy `gwens-admin-key` telah dipensiunkan oleh migrasi sesi P1-01 dan tidak lagi dibaca. Identifier lain tersebut hanya untuk kompatibilitas; identitas produk resminya adalah Sotoayam.

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
- Administrator manusia masuk dengan password scrypt dan sesi opaque yang hanya disimpan sebagai SHA-256 di database. Cookie sesi `HttpOnly`, `Secure`, `SameSite=Strict`; masa absolut, idle timeout, revocation langsung, CSRF, cooldown login, dan audit actor diterapkan server-side.
- `ADMIN_API_KEY` tetap diwajibkan sementara sebagai fallback kompatibilitas Stage A dan dapat dimatikan dengan `ADMIN_API_KEY_FALLBACK_ENABLED=false`. UI tidak menggunakan fallback ini. Penggunaan fallback dicatat sekali per proses.
- Pemulihan password dilakukan dari server dengan `npm run admin:reset-password -- --email <address>`; prompt tidak menampilkan password dan seluruh sesi akun dicabut.
