/**
 * remotion.config.ts
 *
 * Cấu hình cho Remotion CLI và Studio.
 * Chạy `npx remotion studio` tại thư mục gốc để xem preview các caption component.
 *
 * Tham khảo: https://www.remotion.dev/docs/config
 */
import { Config } from '@remotion/cli/config'

Config.setEntryPoint('./src/remotion/index.ts')
Config.setPublicDir('./public')
