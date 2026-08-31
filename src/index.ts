import type { Env } from './env';
import { renderPage, UploadPage, BuildTable } from './render';
import Cloudflare from 'cloudflare';
import { toFile } from 'cloudflare/index';
import type { ScriptUpdateParams } from 'cloudflare/resources/workers-for-platforms/dispatch/namespaces/scripts/scripts';

async function deployWorkerToNamespace(opts: {
  namespaceName: string;
  scriptName: string;
  code: string;
  accountId: string;
  apiToken: string;
  bindings?: ScriptUpdateParams.Metadata['bindings'];
}) {
  const { namespaceName, scriptName, code, accountId, apiToken, bindings = [] } = opts;
  const cf = new Cloudflare({ apiToken });

  try {
    await cf.workersForPlatforms.dispatch.namespaces.get(namespaceName, {
      account_id: accountId,
    });
  } catch {
    await cf.workersForPlatforms.dispatch.namespaces.create({
      account_id: accountId,
      name: namespaceName,
    });
  }

  const moduleFileName = `${scriptName}.mjs`;

  await cf.workersForPlatforms.dispatch.namespaces.scripts.update(
    namespaceName,
    scriptName,
    {
      account_id: accountId,
      metadata: {
        main_module: moduleFileName,
        bindings,
      },
      files: [
        await toFile(new TextEncoder().encode(code), moduleFileName, {
          type: "application/javascript+module",
        }),
      ],
    }
  );

  return scriptName;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS for API requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      // Homepage - show worker creation form and current workers
      if (path === '/' && request.method === 'GET') {
        let body = `
          <p><a href="/upload">Create a new Worker</a></p>
          <hr>
        `;

        try {
          // Get worker mappings from KV
          const kvList = await env.WORKER_MAPPINGS.list();
          const mappings = await Promise.all(
            kvList.keys.map(async (key) => ({
              name: key.name,
              worker_id: await env.WORKER_MAPPINGS.get(key.name) || 'unknown',
              url: `/user-workers/${key.name}`,
            }))
          );
          body += BuildTable('User Workers', mappings);
        } catch (e) {
          body += '<p>Error loading worker data. Make sure your bindings are configured correctly.</p>';
        }

        return new Response(renderPage(body), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      // Worker creation form
      if (path === '/upload' && request.method === 'GET') {
        return new Response(renderPage(UploadPage), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      // Create worker endpoint (handles both form data and JSON)
      if (path === '/create-worker' && request.method === 'POST') {
        let name: string, code: string;

        const contentType = request.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
          const body = await request.json() as { name: string; code: string };
          name = body.name;
          code = body.code;
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
          const formData = await request.formData();
          name = formData.get('workerName') as string;
          code = formData.get('workerCode') as string;
        } else {
          return new Response('Unsupported content type', { status: 400 });
        }

        if (!name || !code) {
          return new Response('Missing name or code', { status: 400 });
        }

        // Validate worker name (alphanumeric and hyphens only)
        if (!/^[a-zA-Z0-9-]+$/.test(name)) {
          return new Response('Worker name must be alphanumeric with hyphens only', { status: 400 });
        }

        try {
          // Upload worker to dispatch namespace
          const workerId = await deployWorkerToNamespace({
            namespaceName: env.DISPATCH_NAMESPACE_NAME,
            scriptName: name,
            code,
            accountId: env.CLOUDFLARE_ACCOUNT_ID,
            apiToken: env.CLOUDFLARE_API_TOKEN,
          });

          // Store mapping in KV
          await env.WORKER_MAPPINGS.put(name, workerId);

          return new Response('Worker created successfully', {
            status: 201,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Content-Type': 'text/plain',
            },
          });
        } catch (error) {
          console.error('Error creating worker:', error);
          return new Response(`Failed to create worker: ${error}`, { status: 500 });
        }
      }

      // Dynamic dispatch to user workers
      if (path.startsWith('/user-workers/')) {
        const workerName = path.slice('/user-workers/'.length);

        if (!workerName) {
          return new Response('Worker name is required', { status: 400 });
        }

        try {
          // Get worker ID from KV
          const workerId = await env.WORKER_MAPPINGS.get(workerName);

          if (!workerId) {
            return new Response(`Worker '${workerName}' not found`, { status: 404 });
          }

          // Dispatch to the user worker
          const worker = env.dispatcher.get(workerId);
          return await worker.fetch(request);
        } catch (error) {
          console.error('Error dispatching to worker:', error);
          if (error instanceof Error && error.message.includes('Worker not found')) {
            return new Response(`Worker '${workerName}' not found`, { status: 404 });
          }
          return new Response('Internal server error', { status: 500 });
        }
      }

      // 404 for all other routes
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('Request error:', error);
      return new Response('Internal server error', { status: 500 });
    }
  },
};