# Catatan Rilis Sotoayam 1.0.0

Sotoayam 1.0.0 adalah rilis pelanggan pertama untuk satu instalasi per pelanggan. Identitas build yang diterima pelanggan tercatat di `release-metadata.json`: versi aplikasi, Git commit, Node.js, jumlah migrasi, dan waktu pembuatan. Nama arsip resmi adalah `sotoayam-v1.0.0-<12-karakter-git-sha>.tar.gz` dan checksum SHA-256 resminya tersedia pada sidecar bernama sama dengan akhiran `.sha256`.

## Yang tersedia

- alur tugas: membuat, melihat detail, mengubah, memindahkan status, dan membatalkan sesuai izin pengguna;
- pengelolaan pengguna dan administrator, Divisi, peran, status aktif, serta otoritas sistem;
- bootstrap web satu kali untuk membuat OWNER pertama dan penyiapan awal bisnis;
- pengaturan runtime dan penanggung jawab bisnis tanpa mengubah secret;
- pairing akun Telegram terautentikasi dengan tautan sekali pakai;
- tujuh preferensi notifikasi, status delivery, dan notifikasi uji melalui pipeline normal;
- liveness `/health` dan readiness `/ready`;
- backup data, verifikasi checksum, dan restore transaksional ke target recovery bersih;
- template deployment Linux VPS dengan systemd dan Nginx HTTPS.

## Batas V1

- Satu instance melayani satu pelanggan; multi-tenancy tidak tersedia.
- Telegram adalah satu-satunya kanal notifikasi yang didukung.
- Deployment yang didukung adalah satu Linux VPS, Nginx HTTPS, aplikasi di loopback, Supabase/PostgreSQL, dan tepat satu Telegram polling worker.
- Sotoayam tidak menyediakan layanan cloud backup terkelola. Operator membuat, memverifikasi, mengenkripsi, memindahkan, dan meretensi backup.
- Secret, akun VPS, domain/DNS, subscription database, dan kepemilikan bot tetap dikelola operator.
- Siklus normal pengguna memakai nonaktifkan/aktifkan kembali. Hard delete pengguna bukan alur dashboard pelanggan.
- Perintah development/reset/seed dan checker internal bukan fitur UI pelanggan dan tidak disertakan sebagai tooling operasional paket.
- Restore V1 hanya menuju database recovery bersih dengan migrasi yang sama; bukan merge atau overwrite database live.

## Tanggung jawab operator

Operator mengikuti [panduan operasi](customer-operator-guide.md), menyelesaikan [checklist penerimaan](customer-acceptance-checklist.md), menjaga secret dan patch OS, memastikan hanya satu poller aktif, serta membuat dan memverifikasi backup secara berkala. Detail pembagian dukungan tercantum di panduan operasi.

## Gate go-live komersial

Artifact release dan checksum yang valid belum otomatis mengizinkan production customer. Clean-room install, restore drill, upgrade/rollback rehearsal, security review, dan seluruh checklist penerimaan harus lulus tanpa blocker sebelum tag final atau commercial go-live disetujui.
