import * as core from '@actions/core'
import {App} from '@octokit/app'
import {Octokit} from '@octokit/rest'
import {readdir, readFile} from 'fs/promises'
import {join} from 'path'
import fetch from 'node-fetch'

async function run(): Promise<void> {
  try {
    const forcePkgNames: string = core.getInput('ForcePkgNames')

    const forcePkgArray = forcePkgNames
      .split(',')
      .map(item => item.trim())
      .filter(item => item.length > 0)

    const GitHubAppId: string = core.getInput('GitHubAppId')
    const GitHubAppPrivateKey: string = core.getInput('GitHubAppPrivateKey')

    const app = new App({
      appId: GitHubAppId,
      privateKey: Buffer.from(GitHubAppPrivateKey, 'base64').toString(),
      Octokit: Octokit.defaults({
        request: {
          fetch
        }
      })
    })

    const {data} = await app.octokit.request('/app')
    core.info(`authenticated as ${data.name}`)

    const masterRepoPatchFiles = await readdir('patches')

    const packages = masterRepoPatchFiles.map(patch => {
      const lastPlusIndex = patch.lastIndexOf('+')
      const lastDotIndex = patch.lastIndexOf('.')
      return {
        pkg: patch.substring(0, lastPlusIndex),
        version: patch.substring(lastPlusIndex + 1, lastDotIndex)
      }
    })

    for await (const {installation} of app.eachInstallation.iterator()) {
      for await (const {octokit, repository} of app.eachRepository.iterator({
        installationId: installation.id
      })) {
        try {
          const owner = repository.owner.login
          const repo = repository.name

          // throws error if 'patches' folder doesn't exist
          await octokit.repos.getContent({
            owner,
            repo,
            path: 'patches'
          })

          core.info(`${owner}/${repo}`)

          for (const {pkg, version} of packages) {
            try {
              const forcePkg = forcePkgArray.includes(pkg)

              const masterRepoPatchFile = masterRepoPatchFiles.find(file =>
                file.startsWith(pkg)
              ) as string

              const masterRepoFilePath = join('patches', masterRepoPatchFile)

              const masterRepoPatchContent = (
                await readFile(masterRepoFilePath)
              ).toString('utf8')

              let branchExists = undefined

              let pkgBranch = `updatepatchfilesbot-${pkg}`
              const pkgName = pkg.split('+').join('/')

              const pullsList = await octokit.pulls.list({
                owner,
                repo,
                state: 'open',
                base: 'main'
              })

              let existingPkgPullRequest = pullsList.data.find(
                pr => pr.head.ref === pkgBranch
              )

              const existingDeBotPullRequest = pullsList.data.find(pr =>
                pr.head.ref.startsWith(
                  `dependabot-npm_and_yarn-${pkg
                    .replace('@', '')
                    .replace('+', '-')}-`
                )
              )

              core.info(
                JSON.stringify({
                  pkg,
                  version,
                  forcePkg,
                  pkgName,
                  pkgBranch,
                  deBotBranch: existingDeBotPullRequest?.head.ref
                })
              )

              if (existingPkgPullRequest) {
                const patchFiles = (
                  await octokit.repos.getContent({
                    owner,
                    repo,
                    ref: `heads/main`,
                    path: 'patches'
                  })
                ).data as {name: string; path: string; sha: string}[]

                const patchFile = patchFiles.find(
                  file =>
                    file.name.startsWith(pkg) &&
                    file.path === masterRepoFilePath
                )

                if (patchFile) {
                  const patch = (
                    await octokit.repos.getContent({
                      owner,
                      repo,
                      ref: `heads/main`,
                      path: masterRepoFilePath
                    })
                  ).data as {content: string}

                  const patchContent =
                    Buffer.from(patch.content, 'base64').toString('utf8') || ''

                  if (patchContent === masterRepoPatchContent) {
                    await octokit.pulls.update({
                      owner,
                      repo,
                      pull_number: existingPkgPullRequest.number,
                      state: 'closed'
                    })
                    await octokit.git.deleteRef({
                      owner,
                      repo,
                      ref: `heads/${pkgBranch}`
                    })
                    existingPkgPullRequest = undefined
                    core.info(`deleted branch ${pkgBranch} and closed pr`)
                  }
                }
              } else {
                try {
                  await octokit.git.deleteRef({
                    owner,
                    repo,
                    ref: `heads/${pkgBranch}`
                  })
                  existingPkgPullRequest = undefined
                  core.info(`deleted branch ${pkgBranch}`)
                } catch (error) {
                  /* empty */
                }
              }

              if (existingDeBotPullRequest) {
                if (existingPkgPullRequest) {
                  await octokit.pulls.update({
                    owner,
                    repo,
                    pull_number: existingPkgPullRequest.number,
                    state: 'closed'
                  })
                  await octokit.git.deleteRef({
                    owner,
                    repo,
                    ref: `heads/${pkgBranch}`
                  })
                  existingPkgPullRequest = undefined
                  core.info(`deleted branch ${pkgBranch} and closed pr`)
                }
                pkgBranch = existingDeBotPullRequest.head.ref
                core.info(`use dependabot pr branch ${pkgBranch}`)
              }

              try {
                branchExists = await octokit.repos.getBranch({
                  owner,
                  repo,
                  branch: pkgBranch
                })
              } catch (error) {
                /* empty */
              }

              const patchFiles = (
                await octokit.repos.getContent({
                  owner,
                  repo,
                  ref: branchExists ? `heads/${pkgBranch}` : `heads/main`,
                  path: 'patches'
                })
              ).data as {name: string; path: string; sha: string}[]

              if (!patchFiles.find(file => file.name.startsWith(pkg))) {
                core.info(`no patch for '${pkgName}' found.`)
                if (!forcePkg) {
                  continue
                }
              }

              const patchFile = patchFiles.find(
                file =>
                  file.name.startsWith(pkg) && file.path === masterRepoFilePath
              )

              if (patchFile) {
                const patch = (
                  await octokit.repos.getContent({
                    owner,
                    repo,
                    ref: branchExists ? `heads/${pkgBranch}` : `heads/main`,
                    path: patchFile.path
                  })
                ).data as {content: string}

                const patchContent =
                  Buffer.from(patch.content, 'base64').toString('utf8') || ''

                if (patchContent === masterRepoPatchContent) {
                  if (branchExists) {
                    core.info(
                      `no updated patch for package '${pkgName}' found.`
                    )
                  } else {
                    core.info(`no new patch for package '${pkgName}' found.`)
                  }
                  continue
                }
              }

              if (!branchExists) {
                const mainSHA = (
                  await octokit.git.getRef({
                    owner,
                    repo,
                    ref: `heads/main`
                  })
                ).data.object.sha
                await octokit.git.createRef({
                  owner,
                  repo,
                  ref: `refs/heads/${pkgBranch}`,
                  sha: mainSHA
                })
                core.info(`create branch '${pkgBranch}'.`)
              }

              const obsoletePatchFile = patchFiles.find(
                file =>
                  file.name.startsWith(pkg) && file.path !== masterRepoFilePath
              )

              if (obsoletePatchFile) {
                await octokit.repos.deleteFile({
                  owner,
                  repo,
                  path: obsoletePatchFile.path,
                  message: `chore(patch): remove obsolete patch for package ${pkgName}`,
                  sha: obsoletePatchFile.sha,
                  branch: pkgBranch
                })
                core.info(`create patch for pgk '${pkgName}'`)
              } else {
                core.info(`update patch for pkg '${pkgName}'`)
              }

              await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: masterRepoFilePath,
                message: `chore(patch): ${
                  obsoletePatchFile || forcePkg ? 'create' : 'update'
                } patch for package ${pkgName}`,
                content: Buffer.from(masterRepoPatchContent).toString('base64'),
                sha: patchFile?.sha,
                branch: pkgBranch
              })

              if (!existingPkgPullRequest) {
                if (!existingDeBotPullRequest) {
                  await octokit.pulls.create({
                    owner,
                    repo,
                    title: `chore(patch): ${
                      obsoletePatchFile || forcePkg ? 'create' : 'update'
                    } patch for package ${pkgName}`,
                    head: pkgBranch,
                    base: 'main'
                  })
                }
              }
            } catch (err) {
              const error = err as Error
              core.error(error.message)
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
    }
  } catch (err) {
    const error = err as Error
    core.setFailed(error.message)
  }
}

run()
