import { serve } from "@flamecast/sdk";
import dotenv from "dotenv";

dotenv.config();

const port = parseInt(process.env.PORT ?? "9080", 10);

serve(port);
console.log(`Restate endpoint listening on :${port}`);
