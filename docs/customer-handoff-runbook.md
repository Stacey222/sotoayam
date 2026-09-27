# Runbook Handoff Customer Sotoayam

Runbook ini menghubungkan prosedur instalasi, penerimaan, dan operasi tanpa shortcut internal.

1. Sotoayam menyerahkan arsip `sotoayam-v1.0.0-<12-karakter-git-sha>.tar.gz`, sidecar checksum `.sha256`, dan release notes. Operator memverifikasi checksum sebelum ekstraksi lalu mencocokkan `release-metadata.json` dengan release yang disetujui.
2. Customer menyediakan Linux VPS, domain/DNS, Supabase/PostgreSQL, bot Telegram, storage backup, dan secret melalui kanal aman.
3. Operator mengikuti [VPS Production](deployment/vps-production.md) untuk memasang runtime, Nginx HTTPS, systemd, dan environment file di luar release.
4. Operator menjalankan migrasi eksplisit dan berhenti bila migration gate gagal; tidak ada reset atau rollback database otomatis.
5. Operator mengaktifkan service, lalu mewajibkan `/health` 200, `/ready` 200 `READY`, dan UI HTTPS 200.
6. Customer membuka `/setup` dan membuat OWNER pertama. Password tidak dikirim melalui tiket atau dicatat di runbook.
7. Customer login, meninjau settings/business actor, lalu melakukan pairing Telegram dari menu Sistem.
8. Customer dan operator mengisi [Checklist Penerimaan](customer-acceptance-checklist.md), termasuk alur pengguna, tugas, notifikasi uji, health, dan readiness.
9. Operator menjalankan `backup:create` serta `backup:verify`, menyimpan archive dan manifest di storage terenkripsi di luar VPS, dan mencatat retensi.
10. Customer memastikan [Panduan Operator](customer-operator-guide.md) dan [Backup dan Pemulihan](deployment/backup-restore.md) dapat diakses oleh petugas yang ditunjuk.
11. Handoff ditandatangani secara operasional hanya setelah seluruh item checklist `PASS`; kegagalan diklasifikasikan sebagai bug aplikasi, masalah operator/infrastruktur, atau kustomisasi tidak didukung.
