import * as http from "node:http"
import { execFileSync } from "node:child_process"

export interface AppCredentials {
  appId: number
  slug: string
  privateKey: string
  webhookSecret: string
  clientId: string
  clientSecret: string
}

/**
 * Run the GitHub App Manifest flow for a single character.
 *
 * 1. Starts a tiny HTTP server on a random port.
 * 2. Opens the browser to a local page that auto-submits the manifest form to GitHub.
 * 3. User confirms on GitHub, which redirects back to the local server with a code.
 * 4. Server exchanges the code for app credentials and shuts down.
 */
export function createGitHubApp(
  characterName: string,
  org?: string,
): Promise<AppCredentials> {
  const port = 24000 + Math.floor(Math.random() * 1000)
  const redirectUrl = `http://localhost:${port}/callback`

  const manifest = JSON.stringify({
    name: `roci-${characterName}`,
    url: `https://github.com/roci-${characterName}`,
    hook_attributes: { active: false },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: {
      issues: "write",
      pull_requests: "write",
      contents: "write",
    },
    default_events: [],
  })

  const formTarget = org
    ? `https://github.com/organizations/${org}/settings/apps/new`
    : `https://github.com/settings/apps/new`

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`)

      if (url.pathname === "/start") {
        // Auto-submitting form — redirects to GitHub immediately
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(
          `<form id="m" method="post" action="${formTarget}">` +
            `<input type="hidden" name="manifest" value='${manifest.replace(/'/g, "&#39;")}'>` +
            `</form><script>document.getElementById("m").submit()</script>`,
        )
        return
      }

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code")
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("Missing code parameter")
          return
        }

        try {
          const resp = await fetch(
            `https://api.github.com/app-manifests/${code}/conversions`,
            {
              method: "POST",
              headers: { Accept: "application/vnd.github+json" },
            },
          )

          if (!resp.ok) {
            const body = await resp.text()
            res.writeHead(200, { "Content-Type": "text/plain" })
            res.end(`GitHub returned ${resp.status}: ${body}`)
            server.close()
            reject(new Error(`GitHub returned ${resp.status}: ${body}`))
            return
          }

          const data = (await resp.json()) as Record<string, unknown>
          const creds: AppCredentials = {
            appId: data.id as number,
            slug: data.slug as string,
            privateKey: data.pem as string,
            webhookSecret: data.webhook_secret as string,
            clientId: data.client_id as string,
            clientSecret: data.client_secret as string,
          }

          res.writeHead(200, { "Content-Type": "text/plain" })
          res.end(
            `App "${data.name}" created. You can close this tab.`,
          )
          server.close()
          resolve(creds)
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/plain" })
          res.end(`Error: ${err}`)
          server.close()
          reject(err)
        }
        return
      }

      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("Not found")
    })

    server.listen(port, () => {
      const startUrl = `http://localhost:${port}/start`
      console.log(`Opening browser for ${characterName}...`)
      try {
        if (process.platform === "darwin") {
          execFileSync("open", [startUrl], { stdio: "ignore" })
        } else if (process.platform === "linux") {
          execFileSync("xdg-open", [startUrl], { stdio: "ignore" })
        } else {
          console.log(`Open this URL: ${startUrl}`)
        }
      } catch {
        console.log(`Open this URL: ${startUrl}`)
      }
    })

    setTimeout(() => {
      server.close()
      reject(new Error("Timed out after 5 minutes"))
    }, 5 * 60 * 1000)
  })
}
