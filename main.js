'use strict';

const debug = require('debug')('farnsworth:main');
const electron = require('electron');
const request = require('request');
const fs = require('fs');
const path = require('path');
const fsExtra = require('fs-extra');
const download = require('download');
const sha1 = require('sha1');
const _ = require('lodash');

// Module to control application life.
const app = electron.app;
// Module to get events from renders.
const ipc = electron.ipcMain;
// Module to create native browser window.
const BrowserWindow = electron.BrowserWindow;
// URL where our backgrounds are
const BACKGROUND_URL = 'https://raw.githubusercontent.com/dconnolly/chromecast-backgrounds/master/backgrounds.json';
const BACKGROUNDS_SAVE_PATH = app.getPath('userData') + '/backgrounds.json';
const BACKGROUNDS_DIR = app.getPath('userData') + '/backgrounds';
const BACKGROUND_DOWNLOAD_THREADS = 4;

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

function init() {
    createWindow();
    downloadBackgrounds();
}

// Create the main window, mostly unchanged from the template
function createWindow () {
    // Create the browser window.
    mainWindow = new BrowserWindow({
        movable: false,
        fullscreen: true,
        title: 'Farnsworth Launcher',
        frame: false,
        backgroundColor: '#000',
        titleBarStyle: 'hidden'
    });

    mainWindow.setFullScreen(true);

    // and load the index.html of the app.
    mainWindow.loadURL('file://' + __dirname + '/ui/index.html');

    // Open the DevTools.
    mainWindow.webContents.openDevTools();

    // Emitted when the window is closed.
    mainWindow.on('closed', function() {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        mainWindow = null;
    });

    mainWindow.on('app-command', function(ev, command) {
        if(command === 'browser-backward' && someWindow.webContents.canGoBack()) {
            someWindow.webContents.goBack();
        }
    });

    mainWindow.on('background-service-ready', function(ev) {
        downloadBackgrounds(ev.sender);
    });
}

function cleanBackgrounds(backgrounds) {
    console.log('Cleaning leftover backgrounds...');

    // Clean up any backgrounds we don't have in the list anymore.
    fs.readDir(BACKGROUND_SAVE_PATH, function(error, files) {
        if(!error) {
            _.each(files, function(f) {
                var filename = path.basename(f, path.extname(f));

                if(!_.find(backgrounds, function(entry) {
                    return path.basename(f) === entry.filename;
                })) {
                    console.log(`Deleting ${f}`);
                    fs.unlink(f);
                }
            });
        }
    });
}

// Download all of the available backgrounds locally just in case we
// need them when we don't have an internet connection.
function downloadBackgrounds() {
    ipc.on('background-service-ready', function(ev) {
        var bgService = ev.sender;

        function doDownload(backgrounds, index, bgAvailable) {
            debug(`Checking for background at index ${index}`);

            return new Promise(function(reject, resolve) {
                if(index < backgrounds.length) {
                    if(backgrounds[index].downloaded) {
                        debug(' - Already downloaded, skipping.');
                        doDownload(backgrounds, index + 1).then(resolve, reject);
                    } else {
                        // Since the URLs contain a variety of filenames, for easiest
                        // portability, we're just going to generate a new filename
                        // based on the sha1 hash of the URL. Overkill? Maybe.
                        // Problematic for other reasons? Also possible.
                        //
                        // As one of the dads would say: "Good enough for who it's for."
                        debug(' - Downloading...');
                        backgrounds[index].filename = `${sha1(backgrounds[index].url)}${path.extname(backgrounds[index].url)}`;
                        var filename = path.join(BACKGROUNDS_DIR, backgrounds[index].filename);

                        console.log(`Downloading ${backgrounds[index].url} to ${filename}...`);
                        download(backgrounds[index].url)
                            .pipe(fs.createWriteStream(filename))
                            .on('close', function() {
                                debug(' - Download complete.');

                                // Set the probably unnecessary downloaded flag to true.
                                backgrounds[index].downloaded = true;

                                // If we haven't told the renderer that a bg is available, do
                                // so now.
                                if(!bgAvailable) {
                                    bgAvailable = true;
                                    bgService.send('background-available', index, backgrounds[index]);
                                }

                                bgService.send('background-data-available', backgrounds);

                                // Save the backgrounds file. Possibly a minor performance impact
                                // serializing JSON and writing to disk every time we download an
                                // image but...see above dad quote.
                                fs.writeFile(BACKGROUNDS_SAVE_PATH, JSON.stringify(backgrounds), function(error) {
                                    if(error) {
                                        bgWindow.send('backgrounds-error', 'Could not save backgrounds list', error);
                                    }

                                    doDownload(backgrounds, index + 1).then(resolve, reject);
                                });
                            }).on('error', function(error) {
                                console.log(`Error downloading ${backgrounds[index].url}:`, error);
                                bgWindow.send('backgrounds-error', `Error downloading ${backgrounds[index].url}`, error);
                                doDownload(backgrounds, index + 1).then(resolve, reject);
                            });
                    }
                } else {
                    // Resolve only when we've processed all images.
                    debug('Completed all files, resolving.');
                    resolve();
                }
            });
        }

        console.log('Loading background images...');

        // Try to be as quick as possible finding the first background.
        // First, see if we already have background data.
        fs.readFile(BACKGROUNDS_SAVE_PATH, function(error, data) {
            var backgrounds = null;
            var bgAvailable = false;

            if(!error) {
                debug('Found existing backgrounds file, loading...');

                // We do, try and load it and, if successful, tell the
                // renderer that we have data and look for an actual
                // downloaded image file. If we have at least one, let
                // the renderer know we're ready to go.
                try {
                    backgrounds = JSON.parse(data);
                    bgService.send('background-data-available', backgrounds);

                    if(_.find(backgrounds, function(entry) {
                        if(!entry.downloaded || !entry.filename)  {
                            return false;
                        }

                        try {
                            fs.accessSync(entry.filename, fs.R_OK);
                            return true;
                        } catch(e) {
                            return false;
                        }
                    })) {
                        debug('Found at least one available background image, notifying renderer.');
                        bgAvailable = true;
                        bgService.send('background-available', backgrounds[index]);
                    }
                } catch(e) {
                    backgrounds = null;
                }
            }

            // Now, load up the background file from the URL and, if successful,
            // save it or update ours by adding new backgrounds and removing those
            // that don't exist.
            request(BACKGROUND_URL, function(error, response, body) {
                if(error || response.statusCode !== 200) {
                    console.error('Error loading backgrounds from ' + BACKGROUND_URL, error);
                    bgService.send('backgrounds-error', 'Error loading backgrounds from ' + BACKGROUND_URL, error);
                } else {
                    var newBgData = JSON.parse(body);

                    // If we already have data, go through it and update it with
                    // data from the server.
                    if(backgrounds !== null) {
                        debug(`Updating data with new entries from remote. Existing count: ${backgrounds.length}, remote length: ${newBgData.length}`);
                        _.each(newBgData, function(entry) {
                            if(!_.find(backgrounds, function(existing) {
                                return entry.url === existing.url;
                            })) {
                                backgrounds.push(entry);
                            }
                        });

                        debug(`New count: ${backgrounds.length}, removing backgrounds that have been removed from remote.`);
                        _.remove(backgrounds, function(entry) {
                            return !_.find(newBgData, function(newEntry) {
                                return newEntry.url === entry.url;
                            });
                        });

                        debug(`New count: ${backgrounds.length}.`);
                    } else {
                        backgrounds = newBgData;
                    }

                    debug(`Total backgrounds: ${backgrounds.length}`);
                    // Notify the renderer that new data is available. Even
                    // though we've already notified them once, give them
                    // a chance to deal with new data being available.
                    bgService.send('background-data-available', backgrounds);

                    // Save the background file locally.
                    fs.writeFile(BACKGROUNDS_SAVE_PATH, JSON.stringify(backgrounds, null, 4), function(error) {
                        if(error) {
                            bgWindow.send('backgrounds-error', 'Could not save backgrounds list', error);
                        }
                    });

                    // Create the backgrounds directory
                    fsExtra.mkdirs(BACKGROUNDS_DIR, function(error) {
                        if(error) {
                            console.error('Could not create directory for backgrounds: ', error);
                            bgService.send('backgrounds-error', 'Could not create directory for backgrounds', error);
                        } else {
                            // Download all of the background images, succeeding whether or not
                            // the promise resolves or rejects.
                            doDownload(backgrounds, 0, bgAvailable).then(function() {
                                debug(`Background downloading succeeded.`);
                                bgService.send('backgrounds-downloaded');

                                cleanBackgrounds(backgrounds);
                            }, function(error) {
                                bgService.send('backgrounds-error', `Unhandled error downloading backgrounds: ${error}`);
                                throw error;
                            });
                        }
                    });
                }
            });
        });
    });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.on('ready', init);

// Quit when all windows are closed.
app.on('window-all-closed', function () {
    app.quit();
});

app.on('activate', function () {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) {
        createWindow();
    }
});
