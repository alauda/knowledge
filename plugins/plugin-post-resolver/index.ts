import { blogPostResolver } from "./BlogPostResolver.js";
import { postInfos, postProducts, postKinds } from "./PostData.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Shanghai");

export * from "./types.js";

export { blogPostResolver, postInfos, postProducts, postKinds };
