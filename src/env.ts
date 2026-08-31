// Copyright (c) 2022 Cloudflare, Inc.
// Licensed under the APACHE LICENSE, VERSION 2.0 license found in the LICENSE file or at http://www.apache.org/licenses/LICENSE-2.0

/*
 * Available bindings -- defined in wrangler.jsonc
 */
export type Env = {
  dispatcher: Dispatcher;
  WORKER_MAPPINGS: KVNamespace;
  DISPATCH_NAMESPACE_NAME: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
}

interface Dispatcher {
  /*
   * GET call on dispatcher
   * scriptName: name of the script
   */
  get: (scriptName: string) => Worker;
}

interface Worker {
  fetch: (request: Request) => Promise<Response>;
}