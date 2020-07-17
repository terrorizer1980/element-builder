/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const fsProm = require('fs').promises;
const path = require('path');
const childProcess = require('child_process');

const rimraf = require('rimraf');

const getSecret = require('./get_secret');
const GitRepo = require('./gitrepo');
const logger = require('./logger');

const Runner = require('./runner');
const DockerRunner = require('./docker_runner');

const WindowsBuilder = require('./windows_builder');

const TYPES = ['win64', 'mac', 'linux'];

const DESKTOP_GIT_REPO = 'https://github.com/vector-im/riot-desktop.git';
const ELECTRON_BUILDER_CFG_FILE = 'electron-builder.json';

async function setDebVersion(ver, templateFile, outFile) {
    // Create a debian package control file with the version.
    // We use a custom control file so we need to do this ourselves
    let contents = await fsProm.readFile(templateFile, 'utf8');
    contents += 'Version: ' + ver + "\n";
    await fsProm.writeFile(outFile, contents);

    logger.info("Version set to " + ver);
}

async function getMatchingFilesInDir(dir, exp) {
    const ret = [];
    for (const f of await fsProm.readdir(dir)) {
        if (exp.test(f)) {
            ret.push(f);
        }
    }
    if (ret.length === 0) throw new Error("No files found matching " + exp.toString() + "!");
    return ret;
}

async function getRepoTargets(repoDir) {
    const confDistributions = await fsProm.readFile(path.join(repoDir, 'conf', 'distributions'), 'utf8');
    const ret = [];
    for (const line of confDistributions.split('\n')) {
        if (line.startsWith('Codename')) {
            ret.push(line.split(': ')[1]);
        }
    }
    return ret;
}

function pullDebDatabase(debDir, rsyncRoot) {
    logger.info("Pulling debian database...", rsyncRoot + 'debian/', debDir);
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            '-av', '--delete', rsyncRoot + 'debian/', debDir,
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

function pushDebDatabase(debDir, rsyncRoot) {
    logger.info("Pushing debian database...");
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            '-av', '--delete', debDir + '/', rsyncRoot + 'debian',
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

async function addDeb(debDir, deb) {
    const targets = await getRepoTargets(debDir);
    logger.info("Adding " + deb + " for " + targets.join(', ') + "...");
    for (const target of targets) {
        await new Promise((resolve, reject) => {
            const proc = childProcess.spawn('reprepro', [
                'includedeb', target, deb,
            ], {
                stdio: 'inherit',
                cwd: debDir,
            });
            proc.on('exit', code => {
                code ? reject(code) : resolve();
            });
        });
    }
}

function pullArtifacts(pubDir, rsyncRoot) {
    logger.info("Pulling artifacts...");
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            '-av', '--delete', rsyncRoot + 'packages.riot.im/', pubDir,
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

function pushArtifacts(pubDir, rsyncRoot) {
    logger.info("Uploading artifacts...");
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            '-av', '--delete', '--delay-updates', pubDir + '/', rsyncRoot + 'packages.riot.im',
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

function copyAndLog(src, dest) {
    logger.info('Copy ' + src + ' -> ' + dest);
    return fsProm.copyFile(src, dest);
}

class DesktopReleaseBuilder {
    constructor(winVmName, winUsername, winPassword, rsyncRoot, desktopBranch) {
        this.winVmName = winVmName;
        this.winUsername = winUsername;
        this.winPassword = winPassword;
        this.rsyncRoot = rsyncRoot;
        // This is the tag / branch of element-desktop to build from, e.g. v1.6.0
        this.desktopBranch = desktopBranch;

        this.pubDir = path.join(process.cwd(), 'packages.riot.im');
        // This should be a reprepro dir with a config redirecting
        // the output to pub/debian
        this.debDir = path.join(process.cwd(), 'debian');
        this.appPubDir = path.join(this.pubDir, 'desktop');
    }

    async start() {
        logger.info(`Starting Element Desktop ${this.desktopBranch} release builder...`);
        this.building = false;

        // get the token passphrase now so a) we fail early if it's not in the keychain
        // and b) we know the keychain is unlocked because someone's sitting at the
        // computer to start the builder.
        // NB. We supply the passphrase via a barely-documented feature of signtool
        // where it can parse it out of the name of the key container, so this
        // is actually the key container in the format [{{passphrase}}]=container
        this.riotSigningKeyContainer = await getSecret('riot_key_container');

        if (this.building) return;

        // XXX: Could be simplified, keeping this mostly unchanged from the
        // develop file for now...
        const toBuild = TYPES;

        if (toBuild.length === 0) return;

        try {
            this.building = true;

            // Sync all the artifacts from the server before we start
            await pullArtifacts(this.pubDir, this.rsyncRoot);

            for (const type of toBuild) {
                try {
                    logger.info(`Starting build of ${type} for ${this.desktopBranch}`);
                    await this.build(type);
                } catch (e) {
                    logger.error("Build failed!", e);
                    // if one fails, bail out of the whole process: probably better
                    // to have all platforms not updating than just one
                    return;
                }
            }

            logger.info("Built packages for: " + toBuild.join(', ') + ": pushing packages...");
            await pushArtifacts(this.pubDir, this.rsyncRoot);
            logger.info("...push complete!");
        } finally {
            this.building = false;
        }
    }

    async writeElectronBuilderConfigFile(type, repoDir, buildVersion) {
        // Electron builder doesn't overlay with the config in package.json,
        // so load it here
        const pkg = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json')));
        const cfg = pkg.build;

        // Electron crashes on debian if there's a space in the path.
        // https://github.com/vector-im/riot-web/issues/13171
        const productName = (type === 'linux') ? 'Element' : pkg.productName;

        Object.assign(cfg, {
            extraMetadata: {
                productName,
            },
            deb: {
                fpm: [
                    "--deb-custom-control=debcontrol",
                ],
            },
        });
        await fsProm.writeFile(
            path.join(repoDir, ELECTRON_BUILDER_CFG_FILE),
            JSON.stringify(cfg, null, 4),
        );
    }

    async build(type) {
        if (type.startsWith('win')) {
            return this.buildWin(type);
        } else {
            return this.buildLocal(type);
        }
    }

    async buildLocal(type) {
        await fsProm.mkdir('builds', { recursive: true });
        const repoDir = path.join('builds', 'element-desktop-' + type + '-' + this.desktopBranch);
        await new Promise((resolve, reject) => {
            rimraf(repoDir, (err) => {
                err ? reject(err) : resolve();
            });
        });
        logger.info("Cloning element-desktop into " + repoDir);
        const repo = new GitRepo(repoDir);
        // Clone element-desktop at tag / branch to build from, e.g. v1.6.0
        await repo.clone(DESKTOP_GIT_REPO, repoDir, '-b', this.desktopBranch);
        logger.info(`...checked out '${this.desktopBranch}' branch, starting build for ${type}`);

        const buildVersion = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json'))).version;

        await this.writeElectronBuilderConfigFile(type, repoDir, buildVersion);
        if (type == 'linux') {
            await setDebVersion(
                buildVersion,
                path.join(repoDir, 'element.io', 'release', 'control.template'),
                path.join(repoDir, 'debcontrol'),
            );
        }

        let runner;
        switch (type) {
            case 'mac':
                runner = this.makeMacRunner(repoDir);
                break;
            case 'linux':
                runner = this.makeLinuxRunner(repoDir);
                break;
        }

        await this.buildWithRunner(runner, buildVersion, type);
        logger.info("Build completed!");

        if (type === 'mac') {
            await fsProm.mkdir(path.join(this.appPubDir, 'install', 'macos'), { recursive: true });
            await fsProm.mkdir(path.join(this.appPubDir, 'update', 'macos'), { recursive: true });

            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist'), /\.dmg$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', f),
                    // be consistent with windows and don't bother putting the version number
                    // in the installer
                    path.join(this.appPubDir, 'install', 'macos', f),
                );
            }
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist'), /-mac.zip$/)) {
                await copyAndLog(path.join(repoDir, 'dist', f), path.join(this.appPubDir, 'update', 'macos', f));
            }

            const latestPath = path.join(this.appPubDir, 'update', 'macos', 'latest');
            logger.info('Write ' + buildVersion + ' -> ' + latestPath);
            await fsProm.writeFile(latestPath, buildVersion);
        } else if (type === 'linux') {
            await pullDebDatabase(this.debDir, this.rsyncRoot);
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist'), /\.deb$/)) {
                await addDeb(this.debDir, path.resolve(repoDir, 'dist', f));
            }
            await pushDebDatabase(this.debDir, this.rsyncRoot);
        }

        logger.info("Removing build dir");
        await new Promise((resolve, reject) => {
            rimraf(repoDir, (err) => {
                err ? reject(err) : resolve();
            });
        });
    }

    makeMacRunner(cwd) {
        return new Runner(cwd);
    }

    makeLinuxRunner(cwd) {
        return new DockerRunner(cwd, path.join('scripts', 'in-docker.sh'));
    }

    async buildWithRunner(runner, buildVersion, type) {
        await runner.run('yarn', 'install');
        await runner.run('yarn', 'run', 'hak', 'check');
        await runner.run('yarn', 'run', 'build:native');
        // This will fetch the Element release from GitHub that matches the version
        // in element-desktop's package.json.
        await runner.run('yarn', 'run', 'fetch', '-d', 'element.io/release');
        await runner.run('yarn', 'build', '--config', ELECTRON_BUILDER_CFG_FILE);
    }

    async buildWin(type) {
        await fsProm.mkdir('builds', { recursive: true });
        const buildDirName = 'element-desktop-' + type + '-' + this.desktopBranch;
        const repoDir = path.join('builds', buildDirName);
        await new Promise((resolve, reject) => {
            rimraf(repoDir, (err) => {
                err ? reject(err) : resolve();
            });
        });

        // we still check out the repo locally because we need package.json
        // to write the electron builder config file, so we check out the
        // repo twice for windows: once locally and once on the VM...
        logger.info("Cloning element-desktop into " + repoDir);
        const repo = new GitRepo(repoDir);
        // Clone riot-desktop at tag / branch to build from, e.g. v1.6.0
        await repo.clone(DESKTOP_GIT_REPO, repoDir, '-b', this.desktopBranch);
        logger.info(`...checked out '${this.desktopBranch}' branch, starting build for ${type}`);

        const buildVersion = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json'))).version;

        await this.writeElectronBuilderConfigFile(type, repoDir, buildVersion);

        const builder = new WindowsBuilder(
            repoDir, type, this.winVmName, this.winUsername, this.winPassword, this.riotSigningKeyContainer,
        );

        logger.info("Starting Windows builder for " + type + '...');
        await builder.start();
        logger.info("...builder started");

        const electronBuilderArchFlag = type === 'win64' ? '--x64' : '--ia32';

        try {
            builder.appendScript('rd', buildDirName, '/s', '/q');
            // Clone riot-desktop at tag / branch to build from, e.g. v1.6.0
            builder.appendScript('git', 'clone', DESKTOP_GIT_REPO, buildDirName, '-b', this.desktopBranch);
            builder.appendScript('cd', buildDirName);
            builder.appendScript('copy', 'z:\\' + ELECTRON_BUILDER_CFG_FILE, ELECTRON_BUILDER_CFG_FILE);
            builder.appendScript('call', 'yarn', 'install');
            builder.appendScript('call', 'yarn', 'run', 'hak', 'check');
            builder.appendScript('call', 'yarn', 'run', 'build:native');
            // This will fetch the Element release from GitHub that matches the
            // version in element-desktop's package.json.
            builder.appendScript('call', 'yarn', 'run', 'fetch', '-d', 'element.io\\release');
            builder.appendScript(
                'call', 'yarn', 'build', electronBuilderArchFlag, '--config', ELECTRON_BUILDER_CFG_FILE,
            );
            builder.appendScript('xcopy dist z:\\dist /S /I /Y');
            builder.appendScript('cd', '..');
            builder.appendScript('rd', buildDirName, '/s', '/q');

            logger.info("Starting build...");
            await builder.runScript();
            logger.info("Build complete!");

            const squirrelDir = 'squirrel-windows' + (type === 'win32' ? '-ia32' : '');
            const archDir = type === 'win32' ? 'ia32' : 'x64';

            await fsProm.mkdir(path.join(this.appPubDir, 'install', 'win32', archDir), { recursive: true });
            await fsProm.mkdir(path.join(this.appPubDir, 'update', 'win32', archDir), { recursive: true });

            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist', squirrelDir), /\.exe$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', squirrelDir, f),
                    path.join(this.appPubDir, 'install', 'win32', archDir, f),
                );
            }
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist', squirrelDir), /\.nupkg$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', squirrelDir, f),
                    path.join(this.appPubDir, 'update', 'win32', archDir, f),
                );
            }
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist', squirrelDir), /^RELEASES$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', squirrelDir, f),
                    path.join(this.appPubDir, 'update', 'win32', archDir, f),
                );
            }
        } finally {
            await builder.stop();
        }

        logger.info("Removing build dir");
        await new Promise((resolve, reject) => {
            rimraf(repoDir, (err) => {
                err ? reject(err) : resolve();
            });
        });
    }
}

module.exports = DesktopReleaseBuilder;
