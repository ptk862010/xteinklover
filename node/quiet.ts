// Nạp đầu tiên trong bản tải về: file chạy một mình không nhận cờ --disable-warning, nên tự lọc cảnh báo
// "SQLite is an experimental feature" của node:sqlite để cửa sổ dòng lệnh gọn. Cảnh báo khác vẫn hiện.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (/SQLite is an experimental feature|Single executable application is an experimental feature/i.test(String(text))) return;
  return (emit as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
