# eDiary

GitHub Deployment:

1. Push this repository to your own GitHub.

2. Open Cloudflare and go to `Workers & Pages`.

3. Select `Create application` -> `Import a repository`.

4. Select this GitHub repository.

5. Enter `npm run deploy` in the `Deploy command`.

6. Add two build secrets on the deployment page:

- `APP_PASSWORD`

- `JWT_SECRET`

7. Click Deploy.