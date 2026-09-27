# Panduan Operator Sotoayam

Panduan ini untuk operasi normal Sotoayam 1.0.0 pada topologi yang didukung. Instalasi awal mengikuti [Clean Install](deployment/clean-install.md), operasi VPS mengikuti [VPS Production](deployment/vps-production.md), dan pemulihan mengikuti [Backup dan Pemulihan](deployment/backup-restore.md).

## 1. Login

Buka URL HTTPS Sotoayam dan login memakai email administrator. Jangan berbagi kata sandi atau cookie sesi. Gunakan **Keluar** setelah selesai. Jika sesi kedaluwarsa, login kembali; jangan menyimpan token atau key aplikasi di browser.

## 2. Pengguna

Menu **Pengguna** menampilkan pencarian, filter, detail, profil, Divisi, peran, status aktif, akses login, dan otoritas sistem sesuai kewenangan. Kata sandi sementara hanya ditampilkan sekali. Simpan atau serahkan melalui kanal aman, lalu minta pengguna menggantinya. Gunakan **Nonaktifkan** untuk menghentikan akses dan **Aktifkan kembali** bila diperlukan. Dashboard tidak menyediakan hard delete pengguna.

Jangan menonaktifkan atau menurunkan otoritas administrator terakhir. Guard produk akan menolak perubahan yang menghilangkan seluruh effective `SYSTEM_ADMIN` atau OWNER yang diperlukan.

## 3. Tugas

Menu **Tugas** digunakan untuk membuat tugas, memfilter status, membuka detail, mengubah data, dan melihat pemilik/Divisi. Hak lihat dan ubah mengikuti peran, assignment, dan batas lintas Divisi; otoritas sistem tidak otomatis memberikan seluruh hak bisnis.

## 4. Perubahan status

Buka detail tugas lalu pilih **Ubah status**. Pilihan yang tampil adalah transisi yang diizinkan dari status saat ini. Status `BLOCKED` memerlukan catatan. Gunakan **Batalkan Tugas** hanya bila kebijakan dan izin mengizinkan. Penolakan otorisasi harus diselesaikan melalui assignment/peran yang benar, bukan dengan mengubah database.

## 5. Pengaturan

Menu **Sistem** memuat **Pengaturan runtime** dan penanggung jawab bisnis. Perubahan memerlukan alasan dan tercatat dalam audit. Pengaturan runtime berlaku tanpa restart sesuai tampilan. Secret, host, cookie security, proxy trust, dan kredensial integrasi tetap deployment-only di environment file.

## 6. Pairing Telegram

Di **Sistem → Siapkan Telegram**, pilih **Hubungkan Telegram**, buka tautan bot, lalu tekan Start. Tautan berlaku 10 menit, sekali pakai, dan terikat pada pengguna yang sedang login. Jangan mengirim token pairing kepada orang lain. Satu identitas Telegram tidak boleh dipakai diam-diam oleh beberapa pengguna.

## 7. Preferensi notifikasi

Setelah pairing, tinjau tujuh preferensi pada kartu Telegram dan pilih **Simpan preferensi**. Preferensi menentukan jenis notifikasi normal yang diterima pengguna; routing reminder dan eskalasi tetap mengikuti aturan produknya sendiri.

## 8. Notifikasi uji

Administrator berwenang dapat memakai **Sistem → Notifikasi Test**, memilih penerima eligible dan jenis yang didukung, lalu mengonfirmasi satu pengiriman. Fitur ini melewati intake, intent, recipient resolution, delivery, fan-out, dan Telegram normal—bukan direct-send bypass. Periksa hasil delivery di **Notifikasi** dan jangan mengulang bila status masih diproses.

## 9. Health dan readiness

- `GET /health` harus mengembalikan HTTP 200 untuk liveness proses.
- `GET /ready` harus mengembalikan HTTP 200 dengan status `READY` sebelum menerima traffic atau menyelesaikan deployment.

`/health` tidak membuktikan koneksi database. `NOT_READY` harus diinvestigasi melalui log dan konfigurasi; jangan mengubah tabel secara manual.

## 10. Backup

Ikuti [panduan backup](deployment/backup-restore.md). Jalankan `npm run backup:create`, lalu `npm run backup:verify` pada setiap hasil. Simpan pasangan archive dan manifest bersama, tetapi simpan secret secara terpisah. Salin hasil ke storage terenkripsi di luar VPS dan terapkan retensi operator.

## 11. Restore

Restore hanya ke target recovery yang baru, bersih, dan telah menerima migrasi release yang sama. Verifikasi checksum wajib dilakukan sebelum restore. Jangan restore ke database production aktif, jangan menonaktifkan trigger/foreign key, dan jangan memakai Transaction Pooler. Setelah restore, validasi login, settings, tugas, `/ready`, mapping Telegram, dan satu notifikasi uji sebelum cutover.

## 12. Restart service

Pada VPS, gunakan akun operator yang berwenang:

```bash
sudo systemctl restart sotoayam.service
sudo systemctl status sotoayam.service --no-pager
```

Pastikan `/ready` kembali `READY`. Jangan menjalankan salinan aplikasi kedua dengan polling Telegram aktif.

## 13. Log

Log service tersedia melalui:

```bash
sudo journalctl -u sotoayam.service --since "30 minutes ago" --no-pager
```

Bagikan hanya potongan yang sudah disanitasi. Jangan menyalin environment, authorization header, cookie, token bot, URL database lengkap, hash/salt password, atau external Telegram ID ke tiket dukungan.

## 14. Bila Telegram berhenti

1. Pastikan `/health` dan `/ready` sehat.
2. Periksa status service dan log terbatas.
3. Pastikan hanya satu instance memiliki `TELEGRAM_POLLING_ENABLED=true`.
4. Pastikan bot masih dimiliki pelanggan dan token environment tersedia tanpa mencetak nilainya.
5. Periksa status pairing/preferensi pengguna dan status delivery di dashboard.
6. Restart service sekali bila diperlukan, lalu kirim satu notifikasi uji. Jangan membuat loop retry manual.

## 15. Yang tidak boleh diubah manual

Jangan mengubah tabel/row database, registry migrasi, RLS/grant, hash credential, session, authority assignment, notification intent/delivery, Telegram offset/dedupe, runtime setting, atau file release. Jangan menjalankan reset/seed development, `supabase db reset`, migration repair, atau SQL ad hoc. Perubahan secret dilakukan melalui environment file dan prosedur deployment; perubahan bisnis dilakukan melalui dashboard/API resmi.

## 16. Upgrade

Sebelum upgrade, jalankan `npm run backup:create` dan `npm run backup:verify`, simpan release aktif serta checksum artifact baru, lalu gunakan `scripts/deploy/deploy-release.sh`. Migrasi harus selesai sebelum symlink `current` berpindah dan service direstart. Setelah aktivasi, wajib periksa `/health`, `/ready`, login OWNER, settings, serta satu alur tugas. Jangan menjalankan `/setup` kembali dan jangan menyalin database lama di atas database baru.

## 17. Rollback

Rollback aplikasi dengan `scripts/deploy/rollback.sh` hanya aman bila release sebelumnya kompatibel dengan schema database yang sudah maju. Script tidak pernah membatalkan migrasi. Bila release lama tidak kompatibel dengan schema baru, hentikan traffic/worker dan pulihkan backup pre-upgrade ke target recovery bersih sesuai panduan; jangan menjalankan SQL reversal manual. Setelah rollback atau recovery, ulangi health, readiness, login, settings, dan alur tugas sebelum membuka traffic.

## 18. Gate commercial go-live

Go-live komersial memerlukan seluruh checklist penerimaan `PASS`, clean-room install artifact resmi, backup/restore drill, upgrade dan rollback rehearsal, security review, checksum/metadata release cocok, serta tidak ada blocker aktif. Artifact yang berhasil dibangun sendiri belum berarti customer production boleh diaktifkan.

## Batas dukungan

Customer/operator bertanggung jawab atas akun dan keamanan VPS, domain/DNS, subscription dan availability Supabase/database, kepemilikan bot Telegram, penyimpanan/rotasi secret, update OS, kapasitas disk/jaringan, serta penyimpanan dan retensi backup.

Sotoayam bertanggung jawab atas perilaku aplikasi pada arsitektur yang didukung, migrasi yang diterbitkan, bootstrap OWNER pertama, pairing Telegram, tooling backup/restore yang didukung, serta template dan dokumentasi deployment.

Klasifikasi insiden:

- **Bug aplikasi:** perilaku Sotoayam menyimpang dari kontrak/dokumentasi pada release dan topologi yang didukung.
- **Masalah infrastruktur/operator:** DNS/TLS/VPS/database/bot/storage/secret atau prosedur operator gagal di luar aplikasi.
- **Kustomisasi tidak didukung:** perubahan source, migrasi, database, proxy, topologi, atau integrasi di luar paket resmi; evaluasi terpisah diperlukan sebelum dukungan produk berlaku.
