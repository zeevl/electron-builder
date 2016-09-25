import { Packager, normalizePlatforms } from "./packager"
import { PackagerOptions } from "./platformPackager"
import { PublishOptions, Publisher } from "./publish/publisher"
import { GitHubPublisher } from "./publish/gitHubPublisher"
import { executeFinally } from "./util/promise"
import { Promise as BluebirdPromise } from "bluebird"
import { isEmptyOrSpaces, isCi, asArray, debug } from "./util/util"
import { log, warn } from "./util/log"
import { Platform, Arch, archFromString } from "./metadata"
import { getRepositoryInfo } from "./repositoryInfo"
import { DIR_TARGET } from "./targets/targetFactory"
import { BintrayPublisher } from "./publish/BintrayPublisher"
import { BintrayOptions } from "./publish/bintray"
import { PublishConfiguration, GithubPublishConfiguration } from "./options/publishOptions"

//noinspection JSUnusedLocalSymbols
const __awaiter = require("./util/awaiter")

export interface BuildOptions extends PackagerOptions, PublishOptions {
}

export interface CliOptions extends PackagerOptions, PublishOptions {
  mac?: Array<string>
  linux?: Array<string>
  win?: Array<string>

  arch?: string

  x64?: boolean
  ia32?: boolean
  armv7l?: boolean

  dir?: boolean

  platform?: string
}

function addValue<K, T>(map: Map<K, Array<T>>, key: K, value: T) {
  const list = map.get(key)
  if (list == null) {
    map.set(key, [value])
  }
  else {
    list.push(value)
  }
}

export function normalizeOptions(args: CliOptions): BuildOptions {
  if (args.targets != null) {
    return args
  }

  let targets = new Map<Platform, Map<Arch, Array<string>>>()

  function processTargets(platform: Platform, types: Array<string>) {
    if (args.platform != null) {
      throw new Error(`--platform cannot be used if --${platform.buildConfigurationKey} is passed`)
    }
    if (args.arch != null) {
      throw new Error(`--arch cannot be used if --${platform.buildConfigurationKey} is passed`)
    }

    function commonArch(): Array<Arch> {
      const result = Array<Arch>()
      if (args.x64) {
        result.push(Arch.x64)
      }
      if (args.armv7l) {
        result.push(Arch.armv7l)
      }
      if (args.ia32) {
        result.push(Arch.ia32)
      }

      return result.length === 0 ? [archFromString(process.arch)] : result
    }

    let archToType = targets.get(platform)
    if (archToType == null) {
      archToType = new Map<Arch, Array<string>>()
      targets.set(platform, archToType)
    }

    if (types.length === 0) {
      const defaultTargetValue = args.dir ? [DIR_TARGET] : []
      if (platform === Platform.MAC) {
        archToType.set(Arch.x64, defaultTargetValue)
      }
      else {
        for (let arch of commonArch()) {
          archToType.set(arch, defaultTargetValue)
        }
      }
      return
    }

    for (let type of types) {
      let arch: string
      if (platform === Platform.MAC) {
        arch = "x64"
        addValue(archToType, Arch.x64, type)
      }
      else {
        const suffixPos = type.lastIndexOf(":")
        if (suffixPos > 0) {
          addValue(archToType, archFromString(type.substring(suffixPos + 1)), type.substring(0, suffixPos))
        }
        else {
          for (let arch of commonArch()) {
            addValue(archToType, arch, type)
          }
        }
      }
    }
  }

  if (args.mac != null) {
    processTargets(Platform.MAC, args.mac)
  }

  if (args.linux != null) {
    processTargets(Platform.LINUX, args.linux)
  }

  if (args.win != null) {
    processTargets(Platform.WINDOWS, args.win)
  }

  if (targets.size === 0) {
    if (args.platform == null && args.arch == null) {
      processTargets(Platform.current(), [])
    }
    else {
      targets = createTargets(normalizePlatforms(args.platform), args.dir ? DIR_TARGET : null, args.arch)
    }
  }

  const result = Object.assign({}, args)
  result.targets = targets

  delete result.dir
  delete result.mac
  delete result.linux
  delete result.win
  delete result.platform
  delete result.arch

  const r = <any>result
  delete r.em

  delete r.m
  delete r.o
  delete r.l
  delete r.w
  delete r.windows
  delete r.osx
  delete r.macos
  delete r.$0
  delete r._
  delete r.version
  delete r.help

  delete result.ia32
  delete result.x64
  delete result.armv7l
  return result
}

export function createTargets(platforms: Array<Platform>, type?: string | null, arch?: string | null): Map<Platform, Map<Arch, Array<string>>> {
  const targets = new Map<Platform, Map<Arch, Array<string>>>()
  for (let platform of platforms) {
    const archs = platform === Platform.MAC ? [Arch.x64] : (arch === "all" ? [Arch.x64, Arch.ia32] : [archFromString(arch == null ? process.arch : arch)])
    const archToType = new Map<Arch, Array<string>>()
    targets.set(platform, archToType)

    for (let arch of archs) {
      archToType.set(arch, type == null ? [] : [type])
    }
  }
  return targets
}

export async function build(rawOptions?: CliOptions): Promise<void> {
  const options = normalizeOptions(rawOptions || {})

  if (options.cscLink === undefined && !isEmptyOrSpaces(process.env.CSC_LINK)) {
    options.cscLink = process.env.CSC_LINK
  }
  if (options.cscInstallerLink === undefined && !isEmptyOrSpaces(process.env.CSC_INSTALLER_LINK)) {
    options.cscInstallerLink = process.env.CSC_INSTALLER_LINK
  }
  if (options.cscKeyPassword === undefined && !isEmptyOrSpaces(process.env.CSC_KEY_PASSWORD)) {
    options.cscKeyPassword = process.env.CSC_KEY_PASSWORD
  }
  if (options.cscInstallerKeyPassword === undefined && !isEmptyOrSpaces(process.env.CSC_INSTALLER_KEY_PASSWORD)) {
    options.cscInstallerKeyPassword = process.env.CSC_INSTALLER_KEY_PASSWORD
  }
  if (options.githubToken === undefined && !isEmptyOrSpaces(process.env.GH_TOKEN)) {
    options.githubToken = process.env.GH_TOKEN
  }
  if (options.bintrayToken === undefined && !isEmptyOrSpaces(process.env.BT_TOKEN)) {
    options.bintrayToken = process.env.BT_TOKEN
  }

  if (options.draft === undefined && !isEmptyOrSpaces(process.env.EP_DRAFT)) {
    options.draft = process.env.EP_DRAFT.toLowerCase() === "true"
  }
  if (options.prerelease === undefined && !isEmptyOrSpaces(process.env.EP_PRELEASE)) {
    options.prerelease = process.env.EP_PRELEASE.toLowerCase() === "true"
  }

  let isPublishOptionGuessed = false
  if (options.publish === undefined) {
    if (process.env.npm_lifecycle_event === "release") {
      options.publish = "always"
    }
    else if (options.githubToken != null) {
      const tag = process.env.TRAVIS_TAG || process.env.APPVEYOR_REPO_TAG_NAME || process.env.CIRCLE_TAG
      if (!isEmptyOrSpaces(tag)) {
        log(`Tag ${tag} is defined, so artifacts will be published`)
        options.publish = "onTag"
        isPublishOptionGuessed = true
      }
      else if (isCi()) {
        log("CI detected, so artifacts will be published if draft release exists")
        options.publish = "onTagOrDraft"
        isPublishOptionGuessed = true
      }
    }
  }

  const packager = new Packager(options)
  const publishTasks: Array<BluebirdPromise<any>> = []

  if (options.publish != null && options.publish !== "never") {
    if (options.githubToken != null || options.bintrayToken != null) {
      publishManager(packager, publishTasks, options, isPublishOptionGuessed)
    }
    else if (isCi()) {
      log(`CI detected, publish is set to ${options.publish}, but neither GH_TOKEN nor BT_TOKEN is not set, so artifacts will be not published`)
    }
  }

  await executeFinally(packager.build(), errorOccurred => {
    if (errorOccurred) {
      for (let task of publishTasks) {
        task!.cancel()
      }
      return BluebirdPromise.resolve(null)
    }
    else {
      return BluebirdPromise.all(publishTasks)
    }
  })
}

function publishManager(packager: Packager, publishTasks: Array<BluebirdPromise<any>>, options: BuildOptions, isPublishOptionGuessed: boolean) {
  const nameToPublisher = new Map<string, Promise<Publisher>>()
  packager.artifactCreated(event => {
    let publishers = event.packager.platformSpecificBuildOptions.publish
    // if explicitly set to null - do not publish
    if (publishers === null) {
      debug(`${event.file} is not published: publish set to null`)
      return
    }

    if (publishers == null) {
      publishers = event.packager.info.devMetadata.build.publish
      if (publishers === null) {
        debug(`${event.file} is not published: publish set to null in the "build"`)
        return
      }

      if (publishers == null && options.githubToken != null) {
        publishers = {provider: "github"}
      }
      // if both tokens are set — still publish to github (because default publisher is github)
      if (publishers == null && options.bintrayToken != null) {
        publishers = {provider: "bintray"}
      }
    }

    for (let publishConfig of asArray(publishers)) {
      if (typeof publishConfig === "string") {
        publishConfig = {provider: publishConfig}
      }

      const publisherName = publishConfig.provider
      let publisher = nameToPublisher.get(publisherName)
      if (publisher == null) {
        publisher = createPublisher(packager, options, publishConfig, isPublishOptionGuessed)
        nameToPublisher.set(publisherName, publisher)
      }

      if (publisher != null) {
        publisher
          .then(it => it == null ? null : publishTasks.push(<BluebirdPromise<any>>it.upload(event.file, event.artifactName)))
      }
    }
  })
}

export async function createPublisher(packager: Packager, options: PublishOptions, publishConfig: PublishConfiguration | GithubPublishConfiguration, isPublishOptionGuessed: boolean = false): Promise<Publisher | null> {
  async function getInfo() {
    const info = await getRepositoryInfo(packager.metadata, packager.devMetadata)
    if (info != null) {
      return info
    }

    if (isPublishOptionGuessed) {
      return null
    }

    warn("Cannot detect repository by .git/config")
    throw new Error(`Please specify 'repository' in the dev package.json ('${packager.devPackageFile}')`)
  }

  if (publishConfig.provider === "github") {
    const config = <GithubPublishConfiguration>publishConfig
    let user = config.owner
    let repo = config.repo
    if (!user || !repo) {
      const info = await getInfo()
      if (info == null) {
        return null
      }

      user = info.user
      repo = info.project
    }

    const version = packager.metadata.version!
    log(`Creating Github Publisher — user: ${user}, project: ${repo}, version: ${version}`)
    return new GitHubPublisher(user, repo, version, options, isPublishOptionGuessed, config)
  }
  if (publishConfig.provider === "bintray") {
    const info = await getInfo()
    if (info == null) {
      return null
    }

    const version = packager.metadata.version!
    //noinspection ReservedWordAsName
    const bintrayInfo: BintrayOptions = {user: info.user, package: info.project, repo: "generic"}
    log(`Creating Bintray Publisher — user: ${bintrayInfo.user}, package: ${bintrayInfo.package}, repository: ${bintrayInfo.repo}, version: ${version}`)
    return new BintrayPublisher(bintrayInfo, version, options)
  }
  return null
}