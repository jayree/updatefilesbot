import * as core from '@actions/core'
import * as github from '@actions/github'
import {readdir, unlink, readFile, writeFile} from 'fs/promises'
import {join} from 'path'

async function run(): Promise<void> {
  try {
    core.setOutput('update', 'false')
    const packages: string[] = core.getInput('packages').split(/\r|\n/)
    const token: string = core.getInput('token')

    const octokit = github.getOctokit(token)
    const {data: patchFiles} = await octokit.rest.repos.getContent({
      owner: 'jayree',
      repo: 'patches',
      path: 'patches'
    })

    if (!Array.isArray(patchFiles)) {
      core.warning(`no patches found.`)
      return
    }

    const localPatchFiles = await readdir('patches')

    for (const pkg of packages) {
      core.debug(pkg)

      const patchFile = patchFiles.find((file: {name: string}) =>
        file.name.startsWith(pkg)
      )

      if (!patchFile) {
        core.warning(`no patch for '${pkg}' found.`)
        return
      }

      const localPatchFile = localPatchFiles.find(file => file.startsWith(pkg))

      if (localPatchFile) {
        const localFile = join('patches', localPatchFile)
        if (localFile !== patchFile.path) {
          await unlink(join('patches', localPatchFile))
        }
        const {data: patch} = await octokit.rest.repos.getContent({
          owner: 'jayree',
          repo: 'patches',
          path: patchFile.path
        })

        if ('content' in patch && patch.type === 'file') {
          const patchContent = Buffer.from(patch.content, 'base64').toString(
            'utf8'
          )
          const fileContent = (await readFile(localFile)).toString('utf8') || ''
          if (patchContent === fileContent) {
            core.info(`no new patch for '${pkg}' found.`)
          } else {
            core.info(`new patch for '${pkg}' found.`)
            await writeFile(patchFile.path, patchContent)
            core.setOutput('update', 'true')
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
