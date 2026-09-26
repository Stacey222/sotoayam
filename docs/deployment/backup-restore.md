# Backup dan Pemulihan Sotoayam

Panduan ini adalah prosedur V1 untuk satu instance Sotoayam. Backup dibuat manual sebagai PostgreSQL logical **data-only** archive dan hanya boleh dipulihkan ke database recovery yang bersih, sudah menerima migrasi Sotoayam yang sama. Prosedur ini tidak menimpa database customer yang sedang berjalan.

## Isi backup

Archive memuat data bisnis dan konfigurasi database: identity customer, credential administrator dalam bentuk hash, OWNER dan assignment `SYSTEM_ADMIN`, runtime settings dan business actor, tugas, audit, notifikasi/delivery, mapping Telegram, serta state operasional persisten.

Data sementara berikut tidak dimuat:

- `admin_sessions` dan `admin_login_attempts`; semua administrator harus login ulang setelah recovery;
- `telegram_pairing_tokens`; token pairing lama tidak boleh hidup kembali;
- baris `telegram_notification_preferences`; tujuh preference direkonstruksi oleh trigger resmi dari boolean `telegram_users` yang masih menjadi sumber rollback P2-03. Nilainya diverifikasi setelah restore.

File manifest di samping archive hanya memuat format, waktu UTC, 25 versi migrasi, Git commit, identitas project/database yang disanitasi, nama artifact, SHA-256, dan daftar pengecualian. Manifest tidak memuat password database, service-role key, token bot, credential mentah, cookie, atau URL koneksi lengkap.

Secret bukan bagian dari backup database. Operator wajib menyimpan secara terpisah di secret manager/penyimpanan terenkripsi: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `INTERNAL_API_KEY`, optional compatibility key, serta konfigurasi environment deployment lain. Jangan simpan secret bersama repository atau manifest.

## Prasyarat dan format koneksi

- Jalankan dari release Sotoayam yang migrasinya sama dengan sumber/target.
- Sediakan `pg_dump`, `pg_restore`, dan `psql` dari versi PostgreSQL yang setidaknya sama baru dengan server.
- Gunakan Direct connection port 5432, atau Supabase Session Pooler port 5432 bila Direct IPv6 tidak tersedia. Transaction Pooler port 6543 ditolak.
- Project ref harus diberikan terpisah dan harus cocok dengan hostname/username URL. URL wajib memakai `sslmode=require`.
- Lindungi file hasil backup dengan permission minimum dan salin ke media terenkripsi di luar VPS/repository. Terapkan retensi operator (contoh: tujuh harian dan satu pre-upgrade); V1 belum menghapus backup otomatis.

PowerShell berikut hanya menaruh secret di environment proses. Jangan menempelkan nilainya ke tiket atau log:

```powershell
$env:SOTOAYAM_BACKUP_SOURCE = 'customer'
$env:SOTOAYAM_BACKUP_DATABASE_URL = '<approved-direct-or-session-pooler-url-with-sslmode=require>'
$env:SOTOAYAM_BACKUP_EXPECTED_PROJECT_REF = '<20-character-project-ref>'
$env:SOTOAYAM_BACKUP_OUTPUT_DIR = 'D:\protected\sotoayam-backups'
npm run backup:create
```

Perintah memverifikasi registry migrasi sumber cocok persis dengan repository, mencetak identitas database tanpa password, lalu membuat pasangan:

```text
sotoayam-<UTC timestamp>.dump
sotoayam-<UTC timestamp>.dump.manifest.json
```

File `.partial` dibersihkan saat gagal dan hasil tidak diumumkan `PASS` sebelum archive serta manifest selesai.

## Verifikasi backup

Verifikasi bersifat read-only dan tidak memerlukan koneksi database:

```powershell
$env:SOTOAYAM_BACKUP_ARTIFACT = 'D:\protected\sotoayam-backups\sotoayam-<timestamp>.dump'
npm run backup:verify
```

Perintah mewajibkan archive dan manifest, memeriksa format V1, nama file, versi migrasi, SHA-256, lalu menjalankan `pg_restore --list`. Kegagalan apa pun menghasilkan exit non-zero. Jalankan setelah setiap backup dan sebelum restore.

## Restore ke target recovery bersih

1. Buat project/database recovery terisolasi. Jangan gunakan database customer aktif atau project development bersama.
2. Terapkan semua migrasi Sotoayam dari release yang sama sampai registry target cocok dengan manifest.
3. Pastikan target belum menjalani `/setup` dan tidak berisi user/task/Telegram/event customer.
4. Pulihkan environment secret secara terpisah, tetapi pertahankan `TELEGRAM_POLLING_ENABLED=false` dan scheduler production nonaktif selama validasi.
5. Jalankan restore dengan frasa konfirmasi persis:

```powershell
$env:SOTOAYAM_BACKUP_ARTIFACT = 'D:\protected\sotoayam-backups\sotoayam-<timestamp>.dump'
$env:SOTOAYAM_RESTORE_DATABASE_URL = '<approved-recovery-direct-or-session-pooler-url-with-sslmode=require>'
$env:SOTOAYAM_RESTORE_EXPECTED_PROJECT_REF = '<recovery-project-ref>'
$env:SOTOAYAM_RESTORE_TARGET = 'recovery'
$env:SOTOAYAM_RESTORE_CONFIRM = 'RESTORE_SOTOAYAM_BACKUP'
npm run backup:restore
```

Restore menolak target ambigu, port transaction pooler, registry migrasi berbeda, target yang tidak bersih, checksum salah, format tidak dikenal, atau frasa salah. Setelah semua guard lolos, seluruh tabel aplikasi di-`TRUNCATE` bersama-sama **tanpa `CASCADE`**, kemudian data dimuat dalam transaksi yang sama dengan trigger dan foreign key tetap aktif. Kegagalan menyebabkan rollback dan tidak mencetak `RESTORE_RESULT = PASS`.

Validasi otomatis setelah restore mewajibkan:

- OWNER aktif dengan admin credential;
- setidaknya satu effective `SYSTEM_ADMIN`;
- `business_actor_user_id` eligible;
- marker bootstrap dan `first_admin_user_id` valid, sehingga `/setup` tetap tertutup;
- seluruh foreign key/role tetap valid saat load;
- mapping Telegram/user channel konsisten;
- tepat tujuh normalized preferences untuk setiap Telegram user;
- runtime settings valid;
- tidak ada session, login-attempt history, atau pairing token lama;
- installation provenance tetap tersedia dan readiness schema probe dapat dijalankan.

## Menjalankan dan menerima recovery

Jalankan aplikasi recovery dengan konfigurasi target recovery dan worker eksternal masih dimatikan. Kemudian:

1. `GET /health` harus 200 untuk liveness;
2. `GET /ready` harus 200/`READY` untuk DB/schema/core wiring;
3. login memakai credential OWNER customer yang dipulihkan;
4. periksa settings, business actor, user, dan tugas;
5. pastikan bot username/token environment milik instance yang benar;
6. aktifkan polling Telegram pada tepat satu runtime saja, lalu kirim satu test notification melalui alur aman dashboard dan pastikan satu delivery.

Mapping chat historis dipertahankan. Restore tidak membuat atau mengganti Telegram ID. Jangan pernah menjalankan recovery dan production polling bersamaan menggunakan token yang sama.

## Kegagalan dan rollback

- Bila create/verify gagal, jangan gunakan pasangan file tersebut; perbaiki koneksi/tooling/disk lalu buat backup baru.
- Bila restore gagal, transaksi data di-rollback. Hapus project recovery disposable atau buat target bersih baru; jangan melakukan SQL repair ad hoc.
- Bila validasi pasca-restore gagal, jangan aktifkan traffic, polling, atau scheduler. Simpan log yang sudah disanitasi dan investigasi versi release/migrasi serta integritas sumber.
- Restore V1 tidak mendukung merge atau overwrite database live. Cutover dilakukan di luar perintah ini setelah recovery diterima; database sumber dan backup asli tetap menjadi rollback point.
