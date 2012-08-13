
var http = require('http');
var path = require('path');
var net = require('net');
var WebSocketServer = require('ws').Server;
var fs = require('fs');
var mdns = require('mdns');
var async = require('async');
var mxutils = require("./mxutils");
var mythprotocol = require("./mythtv/mythprotocol");
var frontends = new (require("./mythtv/frontends"));


// ////////////////////////////////////////////////////////////////////////
// Helpers
// ////////////////////////////////////////////////////////////////////////

var mythProtocolTokens = {
    "64" : "8675309J",
    "65" : "D2BB94C2",
    "66" : "0C0FFEE0",
    "67" : "0G0G0G0",
    "68" : "90094EAD",
    "69" : "63835135",
    "70" : "53153836",
    "71" : "05e82186",
    "72" : "D78EFD6F",
    "73" : "D7FE8D6F",
    "74" : "SingingPotato",
    "75" : "SweetRock",
    "Latest" : "75"
};

var traitOrder = {
    Bookmarked : 1,
    CutList    : 2,
    Movie      : 3,
    Preserved  : 4,
    Watched    : 5,
    Unwatched  : 6,
    Deleted    : 7
};

var slashPattern = new RegExp("[/]");

function titleCompare (t1,t2) {
    if (t1.substr(0,4) === "The ") t1 = t1.substr(4);
    if (t2.substr(0,4) === "The ") t2 = t2.substr(4);
    var t1lc = t1.toLowerCase(), t2lc = t2.toLowerCase();
    return t1lc > t2lc ? 1 : t1lc < t2lc ? -1 : t1 > t2 ? 1 : t1 < t2 ? -1 : 0;
}

function episodeCompare (t1,t2) {
    var t1Val = !!t1.Airdate ? t1.Airdate : (t1.StartTime || t1.SubTitle || t1.FileName);
    var t2Val = !!t2.Airdate ? t2.Airdate : (t2.StartTime || t2.SubTitle || t2.FileName);
    return t1Val === t2Val
        ? (t1.StartTime > t2.StartTime ? -1 : 1)
        : (t1Val > t2Val ? -1 : 1);
}

function videoCompare (v1,v2) {
    var t1 = v1.Title.toLowerCase();
    var t2 = v2.Title.toLowerCase();
    if (t1.substr(0,4) === "the ") t1 = t1.substr(4);
    if (t2.substr(0,4) === "the ") t2 = t2.substr(4);
    return t1 === t2 ? 0 : (t1 < t2 ? -1 : 1);
}

function traitCompare(t1,t2) {
    return traitOrder[t1] < traitOrder[t2] ? -1 : 1;
}

function stringCompare (g1,g2) {
    return g1.toLowerCase() > g2.toLowerCase() ? 1 : -1;
}

// similar to jQuery extend
function copyProperties (src, dst) {
    Object.keys(src).forEach(function (property) {
        if (src.hasOwnProperty(property)) { // don't copy properties from parent objects
            if (typeof(src[property]) === "object" && !src[property].hasOwnProperty("length")) {
                // property is an object but not an array
                if (!dst.hasOwnProperty(property))
                    dst[property] = { };
                copyProperties(src[property], dst[property]);
            } else {
                dst[property] = src[property];
            }
        }
    });
    return dst;
}


// ////////////////////////////////////////////////////////////////////////
// Globals
// ////////////////////////////////////////////////////////////////////////

var backends = [ ];

module.exports = function(args) {

    var myth = {
        isUp : false,               // true = BE has announced itself on bonjour
        connected : false,          // true = we're connected to BE's event socket
        connectPending : false,
        bonjour : undefined
    };

    var backendProtocol = mythProtocolTokens.Latest;

    var backend = {
        events : new mythprotocol(),
        host : "127.0.0.1",
        customHost : false,
        port : 6544,
        method : 'GET',
        headers : { 'content-type': 'text/plain',
                    'connection': 'keep-alive',
                    'accept': 'application/json' }
    };

    var viewButtons = {
        Programs : [ ],
        Properties : [ ],
        About : [
            {
                Class    : "mx-About",
                href     : "/about",
                recGroup : "overview",
                Title    : "Overview"
            },
            {
                Class    : "mx-About",
                href     : "/about",
                recGroup : "terms",
                Title    : "Terms & Credits"
            },
            {
                Class    : "mx-About",
                href     : "/about",
                recGroup : "gplv3",
                Title    : "GPLv3"
            }
        ]
    };

    var byRecGroup = { "All" : [ ], "Default" : [ ] };
    var byFilename = { };
    var byChanId = { };
    var sortedTitles = { };
    var groupNames = [ ];
    var traitNames = [ ];

    var byVideoFolder = { };
    var byVideoId = [ ];

    if (process.env["MX_HOST"]) {
        backend.host = process.env["MX_HOST"];
        backend.customHost = true;
    }
    if (!!args && args.host) {
        backend.host = args.host;
        backend.customHost = true;
    }


    function reqJSON (options, callback) {
        var allOptions = { };
        Object.keys(backend).forEach(function (option) {
            allOptions[option] = backend[option];
        });
        Object.keys(options).forEach(function (option) {
            allOptions[option] = options[option];
        });
        var req = http.request(allOptions, function (reply) {
            var response = "";
            reply.setEncoding('utf8');
            reply.on('data', function (chunk) {
                response += chunk;
                //response += chunk.substr(0, chunk.length-2);
            });

            reply.on('end', function() {
                try {
                    callback(JSON.parse(response.replace(/[\r\n]/g,'')));
                } catch (err) {
                    console.log("reqJSON error:");
                    console.log(err);
                    callback({ });
                }
                //callback(JSON.parse(response));
                response = undefined;
            })
        });
        req.end();
    }


    function toUTCString(localTs) {
        if (backendProtocol > "74")
            return localTs.getFullYear() + "-" + ("0" + (localTs.getMonth()+1)).substr(-2) + "-" + ("0" + localTs.getDate()).substr(-2) + "T" + ("0" + localTs.getHours()).substr(-2) + ":" + ("0" + localTs.getMinutes()).substr(-2) + ":" + ("0" + localTs.getSeconds()).substr(-2);
        else
            return localTs.getUTCFullYear() + "-" + ("0" + (localTs.getUTCMonth()+1)).substr(-2) + "-" + ("0" + localTs.getUTCDate()).substr(-2) + "T" + ("0" + localTs.getUTCHours()).substr(-2) + ":" + ("0" + localTs.getUTCMinutes()).substr(-2) + ":" + ("0" + localTs.getUTCSeconds()).substr(-2);
    }


    function localFromUTCString(utcString) {
        if (backendProtocol > "74")
            return utcString;

        var utc = new Date();

        utc.setUTCFullYear(Number(utcString.substr(0,4)),
                           Number(utcString.substr(5,2))-1,
                           Number(utcString.substr(8,2)));
        utc.setUTCHours(Number(utcString.substr(11,2)),
                        Number(utcString.substr(14,2)),
                        Number(utcString.substr(17,2)));

        return utc.getFullYear() + "-" + ("0" + (utc.getMonth()+1)).substr(-2) + "-" + ("0" + utc.getDate()).substr(-2) + "T" + ("0" + utc.getHours()).substr(-2) + ":" + ("0" + utc.getMinutes()).substr(-2) + ":" + ("0" + utc.getSeconds()).substr(-2);
    }


    function getChanKey(arg1, arg2) {
        if (typeof(arg1) === "object")
            return arg1.Channel.ChanId + ' ' + localFromUTCString(arg1.Recording.StartTs);
        else
            return arg1 + ' ' + arg2;
    }


    // ////////////////////////////////////////////////////////////////////////
    // events to the browser
    // ////////////////////////////////////////////////////////////////////////

    var eventSocket = (function () {

        var wss = new WebSocketServer({ server : args.app });
        wssClients = [ ];

        function blast(msg, client) {
            var msgStr = JSON.stringify(msg);

            var allClients = typeof(client) === "undefined";
            var byIndex = typeof(client) === "number";
            var byCookie = "string";

            if (allClients) console.log('blast ' + msgStr);
            else console.log('blast ' + msgStr + " (" + client + ")");

            var closed = [ ];
            wssClients.forEach(function (webSocket, idx) {
                if (webSocket.isAlive) {
                    if (allClients) webSocket.send(msgStr);
                    if (byIndex && idx == client) webSocket.send(msgStr);
                    if (byCookie && webSocket.mxCookie === client) webSocket.send(msgStr);
                } else {
                    closed.unshift(idx);
                }
            });
            closed.forEach(function (clientIdx) {
                wssClients.remove(clientIdx);
            });
        }

        var recChange = { };
        var inReset = false;
        var recordingsWereReset = false;
        var shutdownSeconds = -1;

        var vidChange = false;
        var recGroupsChanged = false;

        var changeAPI = {
            blast : blast,

            resettingRecordings : function (startingReset) {
                if (inReset && !startingReset)
                    recordingsWereReset = true;
                inReset = startingReset;
            },

            isDoingReset : function () {
                return inReset;
            },

            recordingChange : function (change) {
                if (!inReset) {
                    if (!change.title)
                        change.title = "*";
                    if (!recChange[change.group])
                        recChange[change.group] = { };
                    recChange[change.group][change.title] = true;
                }
            },

            videoChange : function () {
                vidChange = true;
            },

            recGroupChange : function (grp) {
                recGroupsChanged = true;
            },

            groupsDidChange : function () {
                return recGroupsChanged;
            },

            frontendChange : function (feList, clientNum) {
                blast({ Frontends : feList }, clientNum);
            },

            groupChanges : function () {
                return recChange;
            },

            sendChanges : function () {
                if (!inReset) {
                    if (recordingsWereReset) {
                        blast({ Recordings : true, Reset : true });
                        recordingsWereReset = false;
                    } else {
                        var rc = recChange;
                        var grpList = [ ];
                        for (var grp in recChange) {
                            var titleList = [ ];
                            for (var title in recChange[grp]) {
                                blast({ Recordings : true, Group : grp, Title : title});
                                titleList.push(title);
                            }
                            titleList.forEach(function (title) { delete rc[grp][title]; });
                        }
                        grpList.slice(2).forEach(function (grp) { if (rc[grp].length == 0) delete rc[grp]; });
                    }

                    if (recGroupsChanged) {
                        blast({ RecordingGroups : true });
                        recGroupsChanged = false;
                    }
                }

                if (vidChange) {
                    blast({ Videos : true });
                    vidChange = false;
                }
            },

            alertShutdown : function (seconds, clientNum) {
                shutdownSeconds = seconds;
                if (seconds > 0) {
                    blast({ Alert : true, Category : "Servers", Class : "Alert",
                            Message : myth.bonjour.name + " will shut down in " + seconds + " seconds"},
                          clientNum);
                } else if (seconds == 0) {
                    blast({ Alert : true, Category : "Servers", Class : "Alert",
                            Message : myth.bonjour.name + " has commenced shutdown"},
                          clientNum);
                } else {
                    blast({ Alert : true, Category : "Servers", Class : "Alert", Decay : 5,
                            Message : "Shutdown cancelled" });
                }
            },

            alertOffline : function (clientNum) {
                blast({ Alert : true, Category : "Servers", Class : "Alert",
                        Message : "MythTV" + " is offline"},
                      clientNum);
            },

            alertConnecting : function (clientNum) {
                blast({ Alert : true, Category : "Servers", Class : "Info",
                        Message : "MythExpress is loading from " + myth.bonjour.name },
                      clientNum);
            },

            alertConnected : function () {
                blast({ Alert : true, Category : "Servers", Cancel : true });
            },

            alertConnection : function (clientNum) {
                blast({ Alert : true, Category : "Servers", Class : "Info", Decay : 5,
                        Message : "Connected to " + myth.bonjour.fullname },
                      clientNum);
            },

            alertProtocol : function (protocol) {
                blast({ Alert : true, Category : "Servers", Class : "Alert",
                        Message : myth.bonjour.fullname + " uses unrecognized protocol '" + protocol + "'" });
            },

            alertNoServers : function (clientNum) {
                blast({ Alert : true, Category : "Servers", Class : "Alert",
                        Message : "There is no MythTV server available" },
                     clientNum);
            }
        };

        wss.on("connection", function(ws) {
            ws.isAlive = true;

            ws.on("close", function () {
                ws.isAlive = false;
                console.log('ws client closed');
            });

            ws.on("message", function (message) {
                var msg = JSON.parse(message);
                ws.mxCookie = msg.Cookie;
                console.log(wssClients.length - 1 + " has cookie " + ws.mxCookie);
            });

            wssClients.push(ws);
            console.log('new client (' + wssClients.length + ')');

            var clientNum = wssClients.length-1;
            changeAPI.frontendChange(frontends.FrontendList(), clientNum);

            if (false && backends.length == 0)
                changeAPI.alertNoServers(clientNum);
            else if (!myth.isUp)
                changeAPI.alertOffline(clientNum);
            else if (myth.connectPending)
                changeAPI.alertConnecting(clientNum);
            else if (myth.connected && backends.length > 1)
                changeAPI.alertConnected(clientNum);
            else if (shutdownSeconds >= 0)
                changeAPI.alertShutdown(shutdownSeconds, clientNum);
        });

        return changeAPI;

    })();


    // ////////////////////////////////////////////////////////////////////////
    // data model maintenance
    // ////////////////////////////////////////////////////////////////////////

    function addRecordingToRecGroup (recording, recGroup) {
        if (!byRecGroup.hasOwnProperty(recGroup)) {
            byRecGroup[recGroup] = { };
            eventSocket.recGroupChange(recGroup);
        }
        var groupRecordings = byRecGroup[recGroup];
        if (!byRecGroup[recGroup].hasOwnProperty(recording.Title)) {
            byRecGroup[recGroup][recording.Title] = [ ];
            eventSocket.recordingChange({ group : recGroup});
        }
        eventSocket.recordingChange({ group : recGroup, title : recording.Title});
        byRecGroup[recGroup][recording.Title].push(recording);
    }

    function delRecordingFromRecGroup (recording, recGroup) {
        if (byRecGroup.hasOwnProperty(recGroup) && byRecGroup[recGroup].hasOwnProperty(recording.Title)) {
            var episodes = byRecGroup[recGroup][recording.Title];

            var found = false
            for (i = 0; !found && i < episodes.length; i++) {
                if (episodes[i].FileName === recording.FileName) {
                    found = true;
                    episodes.remove(i);
                }
            }

            if (found) {
                eventSocket.recordingChange({ group : recGroup, title : recording.Title});

                if (episodes.length < 2) {
                    eventSocket.recordingChange({ group : recGroup });
                    if (episodes.length == 0) {
                        console.log('that was the last episode');
                        delete byRecGroup[recGroup][recording.Title];
                        if (Object.keys(byRecGroup[recGroup]).length == 0) {
                            console.log('delete rec group ' + recGroup);
                            delete byRecGroup[recGroup];
                            eventSocket.recGroupChange(recGroup);
                        }
                    }
                }
            }
        }
    }

    function assignProperties(program) {
        var mx = { recGroups : { }, traits : { } };

        var flags = backend.events.getProgramFlags(program.ProgramFlags);

        if (program.Recording.RecGroup === "Deleted") {
            mx.traits.Deleted = true;
        } else {
            mx.recGroups.All = true;
            if (program.Recording.hasOwnProperty("RecGroup"))
                mx.recGroups[program.Recording.RecGroup] = true;

            if (flags.BookmarkSet) mx.traits.Bookmarked = true;
            if (flags.HasCutlist) mx.traits.CutList = true;
            if (flags.Preserved) mx.traits.Preserved = true;
            if (flags.Watched) mx.traits.Watched = true;
            else mx.traits.Unwatched = true;
            if (program.hasOwnProperty("ProgramId") && program.ProgramId.length > 0 && program.ProgramId.substr(0,2) === "MV") mx.traits.Movie = true;
        }

        program.ProgramFlags_ = flags;
        program.mx = mx;
    }

    function emptyProgram (fileName) {
        var empty = {
            Title : "",
            StartTime : undefined,
            ProgramFlags : 0,
            Recording : { RecGroup : undefined },
            FileName : fileName
        };
        assignProperties(empty);
        return empty;
    }

    var doLog = false;

    function applyProgramUpdate(newProg) {

        var oldProg = { }, isExistingProgram;

        if (isExistingProgram = byFilename.hasOwnProperty(newProg.FileName)) {
            copyProperties(byFilename[newProg.FileName], oldProg);
            copyProperties(newProg, byFilename[newProg.FileName]);
            newProg = byFilename[newProg.FileName];
        } else {
            oldProg = emptyProgram();
            byFilename[newProg.FileName] = newProg;
            byChanId[getChanKey(newProg)] = newProg.FileName;
        }

        assignProperties(newProg);

        var oldGroups = Object.keys(oldProg.mx.recGroups).concat(Object.keys(oldProg.mx.traits));
        var newGroups = Object.keys(newProg.mx.recGroups).concat(Object.keys(newProg.mx.traits));

        var oldMap = { }, newMap = { };
        oldGroups.forEach(function (group) { oldMap[group] = true; });
        newGroups.forEach(function (group) { newMap[group] = true; });

        if (oldProg.Title != newProg.Title) {
            // remove from all groups under the old title and
            // readd under the new title
            if (doLog) console.log('  title change ' + oldProg.title + " => " + newProg.Title
                                   + " (" + newProg.FileName + ")");
            if (isExistingProgram) {
                oldGroups.forEach(function (group) {
                    if (doLog) console.log('  del from ' + group);
                    delRecordingFromRecGroup(oldProg, group);
                });
            }
            newGroups.forEach(function (group) {
                if (doLog) console.log('  add from ' + group);
                addRecordingToRecGroup(newProg, group);
            });
        } else {
            // remove from groups not appearing in the new and
            // add to groups that weren't in the old list
            //console.log("old groups / new groups for existing prog? " + isExistingProgram);
            //console.log(oldGroups);
            //console.log(newGroups);
            oldGroups.forEach(function (group) {
                if (!newMap.hasOwnProperty(group)) {
                    if (doLog) console.log('  del from ' + group);
                    delRecordingFromRecGroup(oldProg, group);
                }
            });
            newGroups.forEach(function (group) {
                if (!oldMap.hasOwnProperty(group)) {
                    if (doLog) console.log('  add from ' + group);
                    addRecordingToRecGroup(newProg, group);
                }
            });
        }

    }

    // new update events can come before we've processed the GetRecorded request
    var pendingRetrieves = { };

    function takeAndAddRecording(recording, override) {
        var chanKey = getChanKey(recording);
        if (override || !pendingRetrieves.hasOwnProperty(chanKey)) {
            doLog = true;
            applyProgramUpdate(recording);
            doLog = false;
            delete pendingRetrieves[chanKey];
        } else console.log("    ignored due to pending retrieve");
    }

    function retrieveAndAddRecording (chanId, startTs) {
        var chanKey = getChanKey(chanId, startTs);
        if (!pendingRetrieves.hasOwnProperty(chanKey)) {
            pendingRetrieves[chanKey] = true;
            console.log('retrieveAndAddRecording /Dvr/GetRecorded?ChanId=' + chanId + "&StartTime=" + startTs);
            reqJSON(
                {
                    path : '/Dvr/GetRecorded?ChanId=' + chanId + "&StartTime=" + startTs
                },
                function (response) {
                    //console.log('retrieveAndAddRecording');
                    //console.log(response);
                    takeAndAddRecording(response.Program, true);
                });
        } else console.log("    ignored due to pending retrieve");
    };

    function deleteByChanId (chanKey) {
        if (byChanId.hasOwnProperty(chanKey)) {
            var fileName = byChanId[chanKey];

            if (byFilename.hasOwnProperty(fileName)) {
                var prog = byFilename[fileName];
                console.log("deleted dangling program " + prog.Title + " " + prog.StartTime);
                if (prog.hasOwnProperty("mx")) {
                    for (var group in prog.mx.recGroups) {
                        if (doLog) console.log('  del from ' + group);
                        delRecordingFromRecGroup(prog, group);
                    };
                    for (var flag in prog.mx.ProgramFlags_) {
                        if (prog.mx.ProgramFlags_[flag]) {
                            if (doLog) console.log('  del from ' + group);
                            delRecordingFromRecGroup(prog, group);
                        }
                    };
                } else {
                    // clean out any possible straggler records
                    var prog = emptyProgram(fileName);
                    groupNames.concat(trainNames).forEach(function (group) {
                        delRecordingFromRecGroup(emptyProgram, group);
                    });
                }

                delete byFilename[fileName];
            }

            // get rid of stranded streams here until the BE does it
            reqJSON({ path : "/Content/GetFilteredLiveStreamList?FileName=" + byChanId[chanKey] },
                    function (reply) {
                        reply.LiveStreamInfoList.LiveStreamInfos.forEach(function (stream) {
                            console.log("remove stream " + stream.Id);
                            reqJSON({ path : "/Content/RemoveLiveStream?Id=" + stream.Id },
                                    function (reply) { }
                                   );
                        });
                    }
                   );

            delete byChanId[chanKey];
        }
    }

    function updateStructures() {
        var pendingChanges = eventSocket.groupChanges();
        for (var group in pendingChanges) {
            if (byRecGroup.hasOwnProperty(group)) {
                for (var title in pendingChanges[group]) {
                    if (title === "*") {
                        sortedTitles[group] = Object.keys(byRecGroup[group]).sort(titleCompare);
                    } else {
                        if (byRecGroup[group].hasOwnProperty(title)) {
                            byRecGroup[group][title].sort(episodeCompare);
                        }
                    }
                }
            } else {
                if (sortedTitles.hasOwnProperty(group)) {
                    delete sortedTitles[group];
                }
            }
        }

        if (eventSocket.groupsDidChange()) {
            groupNames.length = 0;
            traitNames.length = 0;

            for (var group in byRecGroup) {
                if (traitOrder.hasOwnProperty(group)) {
                    traitNames.push(group);
                } else if (group !== "Default" && group !== "Recordings" && group !== "All") {
                    groupNames.push(group);
                }
            };

            groupNames.sort(stringCompare);
            if (groupNames.length > 1) {
                groupNames.unshift("Default");
                groupNames.unshift("All");
            } else {
                groupNames.unshift("Recordings");
            }

            traitNames.sort(traitCompare);

            viewButtons.Programs.length = 0;
            viewButtons.Properties.length = 0;

            groupNames.forEach(function (groupName) {
                viewButtons.Programs.push({
                    Class : "mx-RecGroup",
                    href : "/recordings",
                    recGroup : groupName,
                    Title : groupName
                });
            });

            viewButtons.Programs.push({
                Class : "mx-Videos",
                href : "/videos",
                Title : "Videos"
            });
            viewButtons.Programs.push({
                Class : "mx-Streams",
                href : "/streams",
                Title : "Streams"
            });

            traitNames.forEach(function (traitName) {
                viewButtons.Properties.push({
                    Class : "mx-RecGroup",
                    href : "/properties",
                    recGroup : traitName,
                    Title : traitName
                });
            });
            viewButtons.Properties.push({
                Class : "mx-Streams",
                href : "/streams",
                Title : "Streams"
            });
        }
    }

    function resetVideoList() {
        Object.keys(byVideoFolder).forEach(function (folder) {
            delete byVideoFolder[folder];
        });
        byVideoId.length = 0;

        byVideoFolder["/"] = { Title : "Videos", List : [ ] };
    }

    function loadVideoList(callback) {
        reqJSON(
            { path : '/Video/GetVideoList' },
            function (videos) {
                videos.VideoMetadataInfoList.VideoMetadataInfos.forEach(function (video) {
                    byVideoId[video.Id] = video;
                    byFilename[video.FileName] = video;
                    var curPath = "";
                    var curList = byVideoFolder["/"];
                    path.dirname(video.FileName).split(slashPattern).forEach(function (folder) {
                        if (folder !== ".") {
                            var newPath = curPath + "/" + folder;
                            var newList = byVideoFolder[newPath];
                            if (!newList) {
                                newList = { Title : folder, List : [ ], VideoFolder : newPath };
                                byVideoFolder[newPath] = newList;
                                curList.List.push(newList);
                            }
                            curPath = newPath;
                            curList = newList;
                        }
                    });
                    curList.List.push(video);
                });

                Object.keys(byVideoFolder).forEach(function (path) {
                    byVideoFolder[path].List.sort(videoCompare);
                });

                callback();
            });
    }

    function initModel () {
        async.auto({

            alertClients : function (finished) {
                eventSocket.alertConnecting();
                eventSocket.resettingRecordings(true);
                finished(null);
            },

            resetStructures : [
                "alertClients",
                function (finished) {
                    Object.keys(sortedTitles).forEach(function (group) {
                        delete sortedTitles[group];
                    });

                    Object.keys(byRecGroup).forEach(function (group) {
                        delete byRecGroup[group];
                    });

                    byRecGroup.All = [ ];
                    byRecGroup.Default = [ ];
                    byRecGroup.Recordings = byRecGroup.Default;  // an alias for when we have only one group

                    Object.keys(byFilename).forEach(function (fileName) {
                        delete byFilename[fileName];
                    });

                    resetVideoList();

                    finished(null);
                }
            ],

            loadRecordings : [
                "resetStructures",
                function (finished) {
                    reqJSON(
                        { path : "/Dvr/GetRecordedList" },
                        function (pl) {
                            pl.ProgramList.Programs.forEach(function (prog) {
                                applyProgramUpdate(prog);
                            });

                            Object.keys(byRecGroup).forEach(function (group) {
                                sortedTitles[group] = Object.keys(byRecGroup[group]).sort(titleCompare);
                                Object.keys(byRecGroup[group]).forEach(function (title) {
                                    byRecGroup[group][title].sort(episodeCompare);
                                });
                                console.log(group + ' ' + Object.keys(byRecGroup[group]).length);
                            });

                            finished(null);
                        });
                }],

            loadVideos : [
                "resetStructures",
                function (finished) {
                    loadVideoList(function () {
                        eventSocket.videoChange();
                        finished(null);
                    });
                }
            ],

            initializeFinished : [
                "loadRecordings", "loadVideos",
                function (finished) {
                    updateStructures();
                    eventSocket.resettingRecordings(false);
                    eventSocket.alertConnected();
                    eventSocket.sendChanges();
                    finished(null);
                }
            ]
        });
    }


    function handleMessage(message) {
        {
            var head = message[0].split(/[ ]/);
            var msgType = head[0];
            if (msgType === "RECORDING_LIST_CHANGE") {
                var change = message.shift().substring(22).split(/[ ]/);
                var changeType = change[0];
                var program = pullProgramInfo(message);
                console.log("RECORDING_LIST_CHANGE " + changeType);
                //console.log(change);
                //console.log(program);
                recordingListChange(change,program);
            }

            else if (msgType === "VIDEO_LIST_CHANGE") {
                resetVideoList();
                loadVideoList(function () {
                    eventSocket.videoChange();
                });
            }

            else if (msgType === "SHUTDOWN_COUNTDOWN") {
                eventSocket.alertShutdown(head[1]);
            }

            else if (msgType === "SHUTDOWN_NOW") {
                eventSocket.alertShutdown(0);
            }

            else if (msgType === "UPDATE_FILE_SIZE" ||
                     msgType === "ASK_RECORDING" ||
                     msgType === "COMMFLAG_START" ||
                     msgType === "COMMFLAG_UPDATE" ||
                     msgType === "SCHEDULE_CHANGE") {
            }


            else {
                console.log('Non system event:');
                console.log(message);
            }
        }
    }


    // ////////////////////////////////////////////////////////////////////////
    // events from the backend
    // ////////////////////////////////////////////////////////////////////////

    function updateModelAndPublish () {
        updateStructures();
        eventSocket.sendChanges();
    }

    backend.events.on("connect", function () {
        eventSocket.alertConnection();
        initModel();
    });

    backend.events.on("protocolVersion", function (version) {
        changeAPI.alertProtocol(versionl);
    });

    backend.events.on("disconnect", function () {
        eventSocket.alertOffline();
    });

    backend.events.on("RECORDING_LIST_CHANGE", function (event, program) {

        if (event.changeType === "ADD") {
            console.log("RECORDING_LIST_CHANGE add " + event.ChanId + " / " + event.startTs);
            retrieveAndAddRecording(event.ChanId, event.StartTs)
        }

        else if (event.changeType === "UPDATE") {
            console.log("RECORDING_LIST_CHANGE update " + program.Title + " " + program.StartTime + " " + program.SubTitle);
            //console.log(program);
            takeAndAddRecording(program);
        }

        else if (event.changeType === "DELETE") {
            // deletes are typically handled with update's
            // change to recgroup = Deleted but here we handle
            // other delete paths such as expiry.
            console.log("RECORDING_LIST_CHANGE delete " + event.ChanId + " / " + event.startTs);
            deleteByChanId(event.ChanId + ' ' + event.StartTs);
        }

        else {
            console.log('unhandled program change: ' + event.changeType);
            console.log(program);
        }

        updateModelAndPublish();

    });

    backend.events.on("REC_EXPIRED", function (event) {
        console.log(event);
        deleteByChanId(event.chanid + ' ' + event.starttime);
        updateModelAndPublish();
    });

    backend.events.on("VIDEO_LIST_CHANGE", function () {
        resetVideoList();
        loadVideoList(function () {
            eventSocket.videoChange();
        });
    });

    backend.events.on("SHUTDOWN_COUNTDOWN", function (seconds) {
        eventSocket.alertShutdown(seconds);
    });

    backend.events.on("SHUTDOWN_NOW", function (seconds) {
        eventSocket.alertShutdown(0);
    });


    // ////////////////////////////////////////////////////////////////////////
    // Bonjour
    // ////////////////////////////////////////////////////////////////////////

    myth.bonjourService = (function () {
        var backendBrowser = mdns.createBrowser(mdns.tcp('mythbackend'));

        backendBrowser.on('serviceUp', function(service) {
            //console.log("mythtv up: ", service.name);
            if (!myth.connected) {
                if (myth.affinity && myth.affinity !== service.host)
                    return;
                myth.isUp = true;
                var addr = mxutils.filterIPv4(service.addresses);
                if (addr.length > 0) {
                    myth.bonjour = service;
                    myth.up = true;
                    backend.host = addr[0];
                    console.log(service.name + ': ' + backend.host);
                    backend.events.connect({
                        host       : backend.host,
                        clientName : "MythExpress.EventListener",
                        mode       : backend.events.Monitor,
                        eventMode  : backend.events.AllEvents
                    });
                }
            }
        });

        backendBrowser.on('serviceDown', function(service) {
            //console.log("mythtv down: ", service.name);
            if (myth.connected) {
                myth.isUp = service.name === myth.bonjour.name;
                if (!myth.isUp)
                    eventSocket.alertOffline();
            }
        });

        backendBrowser.start();

        return {
            restart : function () {
                myth.up = false;
                if (false) {
                    backendBrowser.stop();  frontendBrowser.stop();
                    backendBrowser.start(); frontendBrowser.start();
                }
            }
        };
    })();

    frontends.on("change", function (feList) {
        eventSocket.frontendChange(feList);
    });

    // ////////////////////////////////////////////////////////////////////////
    // what routes see
    // ////////////////////////////////////////////////////////////////////////

    return {

        initModel : initModel,
        byRecGroup : byRecGroup,
        byFilename : byFilename,
        sortedTitles : sortedTitles,
        viewButtons : viewButtons,

        groupNames : groupNames,
        traitNames : traitNames,

        byVideoFolder : byVideoFolder,
        byVideoId : byVideoId,

        blast     : eventSocket.blast,

        FormatAirdate : function(airdate) {
            var d = new Date(airdate.substr(0,4), airdate.substr(5,2)-1, airdate.substr(8,2));
            return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getDay()]
                + ", "
                + ["January","February","March","April","May","June","July",
                   "August","September","October","November","December"][d.getMonth()]
                + " " + d.getDate() + ", " + d.getFullYear();
        },

        GetRecordingRecord : function (chanId, startTs) {
            return byChanId[getChanKey(chanId, startTs)];
        },

        StreamRecording : function (fileName, encoding, callback) {
            var recording = byFilename[fileName];

            console.log('Stream Recording');
            console.log(encoding);

            reqJSON(
                {
                    path : "/Content/AddRecordingLiveStream?ChanId=" + recording.Channel.ChanId + "&StartTime=" + recording.Recording.StartTs + "&Width=" + encoding.Width + "&Bitrate=" + encoding.Bitrate
                },
                function (reply) {
                    callback(reply);
                }
            );
        },


        RemoveRecording : function (ChanId, StartTs, callback) {
            reqJSON(
                {
                    path : "/Dvr/RemoveRecorded?ChanId=" + ChanId + "&StartTime=" + StartTs
                },
                function (reply) {
                    callback(reply);
                }
            );
        },


        StreamVideo : function (videoId, encoding, callback) {
            var video = byVideoId[videoId];

            console.log('Stream Video');
            console.log("/Content/AddVideoLiveStream?Id=" + video.Id);
            console.log(encoding);

            reqJSON(
                {
                    path : "/Content/AddVideoLiveStream?Id=" + video.Id
                },
                function (reply) {
                    callback(reply);
                }
            );
        },


        StopStream : function (StreamId) {
            reqJSON(
                {
                    path : "/Content/StopLiveStream?Id=" + StreamId
                },
                function (reply) {
                    console.log(reply);
                }
            );
        },


        StreamList : function (callback) {
            reqJSON(
                {
                    path : "/Content/GetLiveStreamList"
                },
                function (reply) {
                    callback(reply);
                }
            );
        },

        FilteredStreamList : function (fileName, callback) {
            reqJSON(
                {
                    path : "/Content/GetFilteredLiveStreamList?FileName=" + fileName
                },
                function (reply) {
                    callback(reply);
                }
            );
        },


        GetLiveStream : function (streamId, callback) {
            reqJSON(
                {
                    path : "/Content/GetLiveStream?Id=" + streamId
                },
                function (reply) {
                    callback(reply);
                }
            );
        },


        RemoveLiveStream : function (streamId, callback) {
            reqJSON(
                {
                    path : "/Content/RemoveLiveStream?Id=" + streamId
                },
                function (reply) {
                    callback(reply);
                }
            );
        },


        DecodeVideoProps : function (recording) {
            return backend.events.getVideoProps(recording.VideoProps);
        },


        CustomHost : function () {
            if (backend.customHost) {
                return backend.host;
            } else {
                return false;
            }
        },

        MythServiceHost : function (request) {
            if (backend.customHost) {
                return backend.host + ":" + backend.port;
            } else {
                // use the client's path to us
                return request.headers.host.split(/:/)[0] + ":" + backend.port;
            }
        }

    };

};
