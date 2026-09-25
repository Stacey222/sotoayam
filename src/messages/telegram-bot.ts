export const telegramBotMessages = {
  pairingSucceeded: "Telegram berhasil terhubung ke akun Sotoayam Anda.",
  pairingFailed: "Tautan Telegram tidak valid atau sudah kedaluwarsa. Buat tautan baru dari Sotoayam.",
  privateChatOnly: {
    task: "Task Console hanya tersedia melalui private chat.",
    it: "IT Console hanya tersedia melalui private chat.",
    owner: "Owner Console hanya tersedia melalui private chat.",
  },
  registrationFailed: "Registrasi Telegram Sotoayam belum dapat diproses. Silakan coba lagi beberapa saat atau hubungi Admin Sotoayam.",
  accessStateFailed: "Status akun Sotoayam belum dapat dimuat. Silakan coba lagi beberapa saat atau hubungi Admin Sotoayam.",
  registrationPending: "Registrasi Telegram Sotoayam berhasil.\n\nStatus: Menunggu aktivasi Admin.\n\nSilakan hubungi Admin Sotoayam untuk menentukan Divisi dan Role Anda.",
} as const;

export function formatActiveTelegramAccount(divisionCode: string | null, roleCode: string | null): string {
  return `Akun Sotoayam aktif.\n\nDivisi: ${divisionCode}\nRole: ${roleCode}\nStatus: Aktif`;
}
