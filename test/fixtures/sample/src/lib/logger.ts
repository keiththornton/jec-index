export class Logger {
  info(msg: string): void { console.log(msg); }
  error(msg: string): void { console.error(msg); }
}
export const logger = new Logger();
