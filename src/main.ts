import * as core from '@actions/core'
import {createAppAuth} from '@octokit/auth-app'
import {Octokit} from '@octokit/rest'
import {readdir, readFile} from 'fs/promises'
import {join} from 'path'

async function run(): Promise<void> {
  try {
    const GitHubAppId: string = core.getInput('GitHubAppId')
    const GitHubAppPrivateKey: string = core.getInput('GitHubAppPrivateKey')
    const GitHubAppInstallationId: string = core.getInput(
      'GitHubAppInstallationId'
    )

    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: GitHubAppId,
        privateKey: Buffer.from(GitHubAppPrivateKey, 'base64').toString(),
        installationId: GitHubAppInstallationId
      }
    })

    const repositories = (await octokit.paginate(
      octokit.apps.listReposAccessibleToInstallation
    )) as unknown as {name: string; owner: {login: string}}[]

    for (const repository of repositories) {
      const owner = repository.owner.login
      const repo = repository.name

      try {
        const {data: patchFiles} = await octokit.repos.getContent({
          owner,
          repo,
          path: 'patches'
        })

        if (Array.isArray(patchFiles)) {
          core.info(`${owner}/${repo}`)

          const masterPatchFiles = await readdir('patches')

          const packages = masterPatchFiles.map(patch => {
            const lastPlusIndex = patch.lastIndexOf('+')
            return patch.substring(0, lastPlusIndex)
          })

          for (const pkg of packages) {
            const masterPatchFile = masterPatchFiles.find(file =>
              file.startsWith(pkg)
            )

            if (!masterPatchFile) {
              core.warning(`no master patch for '${pkg}' found.`)
              break
            }

            const patchFile = patchFiles.find(file => file.name.startsWith(pkg))

            if (!patchFile) {
              core.warning(`no patch for '${pkg}' found.`)
              break
            }

            const {data: patch} = await octokit.repos.getContent({
              owner,
              repo,
              path: patchFile.path
            })

            if ('content' in patch && patch.type === 'file') {
              const patchContent =
                Buffer.from(patch.content, 'base64').toString('utf8') || ''
              const masterFilePath = join('patches', masterPatchFile)

              const masterPatchContent = (
                await readFile(masterFilePath)
              ).toString('utf8')
              if (patchContent === masterPatchContent) {
                core.info(`no new patch for package '${pkg}' found.`)
              } else {
                const mainSHA = (
                  await octokit.git.getRef({
                    owner,
                    repo,
                    ref: `heads/main`
                  })
                ).data.object.sha

                let branchExists = undefined

                const pkgBranch = `updatepatchfilesbot-${pkg}`

                try {
                  branchExists = await octokit.repos.getBranch({
                    owner,
                    repo,
                    branch: pkgBranch
                  })
                } catch (error) {
                  /* empty */
                }

                if (branchExists) {
                  await octokit.git.updateRef({
                    owner,
                    repo,
                    ref: `heads/${pkgBranch}`,
                    sha: mainSHA,
                    force: true
                  })

                  core.info(`reset branch '${pkgBranch}'.`)
                } else {
                  // Falls der Branch nicht existiert, erstelle einen neuen Branch aus "main"
                  await octokit.git.createRef({
                    owner,
                    repo,
                    ref: `refs/heads/${pkgBranch}`,
                    sha: mainSHA
                  })
                  core.info(`create branch '${pkgBranch}'.`)
                }

                if (masterFilePath !== patchFile.path) {
                  await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: patchFile.path,
                    message: `chore(patch): remove obsolete patch ${patchFile.path}`,
                    sha: patchFile.sha,
                    branch: pkgBranch
                  })
                }

                core.info(`update patch '${pkg}'`)
                await octokit.repos.createOrUpdateFileContents({
                  owner,
                  repo,
                  path: masterFilePath,
                  message: `chore(patch): update patch ${masterFilePath}`,
                  content: Buffer.from(masterPatchContent).toString('base64'),
                  sha: patchFile.sha,
                  branch: pkgBranch
                })

                try {
                  await octokit.pulls.create({
                    owner,
                    repo,
                    title: `chore(patch): update patch ${masterFilePath}`,
                    head: pkgBranch,
                    base: 'main',
                    body: `update patch file for package: ${pkg}`
                  })
                } catch (error) {
                  /* empty */
                }
              }
            }
          }
        }
      } catch (err) {
        const error = err as Error
        const allowedErrors = [
          {message: 'Not Found'},
          {message: 'Resource not accessible by integration'}
        ]
        if (!allowedErrors.some(e => e.message === error.message)) {
          core.error(error.message)
        }
      }
    }
  } catch (err) {
    const error = err as Error
    core.setFailed(error.message)
  }
}

run()
