# Onboarding customer Sotoayam

Panduan ini dimulai setelah OWNER pertama selesai dibuat melalui `/setup`. Operator deployment tetap menyiapkan bot melalui BotFather, menyimpan `TELEGRAM_BOT_TOKEN` dan username bot (tanpa `@`) pada `TELEGRAM_BOT_USERNAME`, serta memastikan hanya satu instance yang menjalankan polling.

1. Masuk ke dashboard sebagai OWNER pertama, lalu buka **Sistem**.
2. Tinjau zona waktu, interval pengingat, kebijakan peringatan, dan penanggung jawab bisnis. Simpan perubahan bila diperlukan.
3. Pada **Siapkan Telegram**, pilih **Hubungkan Telegram**. Browser membuka bot resmi; tekan **Start**. Tautan pairing berlaku 10 menit dan hanya dapat dipakai sekali. Jangan membagikan tautan tersebut.
4. Kembali ke halaman Sistem dan muat ulang bila status belum berubah menjadi **Terhubung**.
5. Pilih tujuh preferensi notifikasi yang diperlukan lalu tekan **Simpan preferensi**.
6. Pada **Notifikasi Test**, pilih akun yang terhubung dan satu jenis notifikasi, lalu kirim satu pengujian. Pengujian tetap melewati event, intent, delivery, dan pengiriman Telegram normal.
7. Pastikan daftar **Kesiapan penggunaan** telah tercentang dan `/ready` menunjukkan layanan siap.

Customer tidak perlu mengetahui chat ID Telegram, membuka Supabase, menjalankan SQL, atau mengubah source code. Jika tautan kedaluwarsa atau pernah dipakai, buat tautan baru dari dashboard.
