import { agentNative } from "@agent-native/core/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

const reactRouterPlugins = reactRouter as unknown as () => any[];
const agentNativePlugins = agentNative as unknown as (
  options?: Parameters<typeof agentNative>[0],
) => any[];

export default defineConfig({
  server: {
    allowedHosts: ["hellos-macbook-pro.tail6d8e8c.ts.net"],
  },
  plugins: [
    ...reactRouterPlugins(),
    ...agentNativePlugins({ ssrStubs: ["shiki"] }),
  ],
});
