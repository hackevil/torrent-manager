/**
 * TODO : Stream close action
 */

var _               = require('underscore');
var async           = require('async');
var http            = require('http');
var path            = require('path');
var fs              = require('fs');
var srt             = require('subtitles-parser');
var express         = require('express');
var unzip           = require('unzip');
var exec            = require('child_process').exec;
var charsetDetector = require('node-icu-charset-detector');
var Iconv           = require('iconv').Iconv;
var url             = require('url');
var request         = require('request');
var config          = require('./config');

/**
 * @see http://stackoverflow.com/questions/15900485/correct-way-to-convert-size-in-bytes-to-kb-mb-gb-in-javascript
 */
function bytesToSize(bytes) {
    var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    if (bytes == 0) return '0 Bytes';
    var i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
    return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
}

/**
 * @see https://github.com/mooz/node-icu-charset-detector
 */
function bufferToString(buffer) {
    var charset = charsetDetector.detectCharset(buffer).toString();

    try {
        return buffer.toString(charset);
    } catch (x) {
        var charsetConverter = new Iconv(charset, "utf8");
        return charsetConverter.convert(buffer).toString();
    }
}

/**
 * Stream port queue
 */
var streamPort = null;
var streamPortQueue = async.queue(function(task, callback){
    if (streamPort == null) {
        streamPort = config.streamPortRange[0];
    } else {
        streamPort++;
    }
    callback(null, streamPort);
}, 1);

/**
 * Application
 */
var app = express();
app.use(express.static('public'));

// simple logger
app.use(function(req, res, next){
    console.log('%s %s', req.method, req.url);
    next();
});

/**
 * Get folders & files
 */
app.get('/api/v1/ls', function(req, res){
    var currentPath = path.normalize(req.query.path || '/');
    var realPath = config.repository + currentPath;
    var pathInfo = fs.readdirSync(realPath);
    var files = [];
    var folders = [];

    _.each(pathInfo, function(item){
        var stat = fs.statSync(realPath + '/' + item);
        item = {
            name: item,
            path: currentPath + '/' + item
        };

        if (stat.isFile()) {
            item.size = bytesToSize(stat.size);
            // TODO : Check other formats
            var extension = path.extname(item.path);
            if (extension == '.mp4') {
                item.isVideo = true;
            } else if(extension == '.srt') {
                item.isSubtitle = true;
            } else if(extension == '.zip' || extension == '.rar') {
                item.isArchive = true;
            } else {
                item.isNormal = true;
            }

            files.push(item);
        } else {
            item.path = currentPath + '/' + item.name;
            item.totalCount = 0; // TODO
            item.totalSize = 0; // TODO

            folders.push(item);
        }
    });

    res.send({
        currentPath: currentPath,
        files: files,
        folders: folders
    });
});

/**
 * Download selected file.
 */
app.get('/api/v1/download', function(req, res){
    var currentPath = path.normalize(req.query.path || '/');
    var realPath = config.repository + currentPath;

    res.set('Content-Disposition', 'attachment; filename=' + path.basename(realPath));
    res.sendfile(realPath);
});

/**
 * Convert srt file to webvtt
 */
app.get('/api/v1/subtitle', function(req, res){
    var currentPath = path.normalize(req.query.path || '/');
    var realPath = config.repository + currentPath;
    var buffer = fs.readFileSync(realPath);
    var data = srt.fromSrt(bufferToString(buffer));

    var output = "WEBVTT\n\n";
    _.each(data, function(item){
        output += item.id + "\n";
        output += item.startTime.toString().replace(',', '.') + " --> " + item.endTime.toString().replace(',', '.') + "\n";
        output += item.text + "\n\n";
    });

    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.send(new Buffer(output));
});

/**
 * Stream selected video file
 */
app.get('/api/v1/stream', function(req, res){
    var currentPath = path.normalize(req.query.path || '/');
    var realPath = config.repository + currentPath;

    streamPortQueue.push({}, function(err, port){
        if (err) {
            // TODO : Send error message
            res.send({});
            return;
        }

        /**
         * @see https://gist.github.com/lleo/8614403
         */
        var streamServer = http.createServer(function (streamReq, streamRes) {
            var stat = fs.statSync(realPath)
                , total = stat.size;

            if (streamReq.headers['range']) {
                var range = streamReq.headers.range
                    , parts = range.replace(/bytes=/, "").split("-")
                    , partialstart = parts[0]
                    , partialend = parts[1]
                    , start = parseInt(partialstart, 10)
                    , end = partialend ? parseInt(partialend, 10) : total-1
                    , chunksize = (end-start)+1;

                console.log('RANGE: ' + start + ' - ' + end + ' = ' + chunksize);

                var file = fs.createReadStream(realPath, {start: start, end: end});

                streamRes.writeHead(206
                    , { 'Content-Range': 'bytes ' + start + '-' + end + '/' + total
                        , 'Accept-Ranges': 'bytes', 'Content-Length': chunksize
                        , 'Content-Type': 'video/mp4'
                    });
                file.pipe(streamRes);
            }
            else {
                console.log('ALL: ' + total);
                streamRes.writeHead(200
                    , { 'Content-Length': total
                        , 'Content-Type': 'video/mp4'
                    });
                fs.createReadStream(path).pipe(streamRes);
            }
        }).listen(port, function(){
            console.log('Streaming on port %d for file : %s', streamServer.address().port, realPath);

            res.send({
                url: 'http://' + config.streamUrl + ':' + streamServer.address().port
            });
        });
    });
});

/**
 * Extract zip or rar file
 */
app.get('/api/v1/extract', function(req, res){
    var currentPath = path.normalize(req.query.path || '/');
    var realPath = config.repository + currentPath;
    var extname = path.extname(realPath);
    var basename = path.basename(realPath, extname);
    var output = path.dirname(realPath) + '/' + basename;

    if (extname == '.zip') {
        fs.createReadStream(realPath).pipe(unzip.Extract({path: output})).on('close', function(){
            res.send({});
        });
    } else if (extname == '.rar') {
        console.log("unrar x '" + realPath + "' '" + output + "/'");
        exec("unrar x '" + realPath + "' '" + output + "/'", function(error, stdout, stderr){
            res.send({});
        });
    } else {
        res.send({});
    }
});

/**
 * Upload from url
 */
app.get('/api/v1/upload-from-url', function(req, res){
    // TODO : Dosya adı bulunmayan bağlantılarda sorun çıkabilir.
    var currentPath = path.normalize(req.query.path || '/');
    var realPath = config.repository + currentPath;

    var downloadUrl = req.query.url;
    var parsedUrl = url.parse(downloadUrl);
    var basename = path.basename(parsedUrl.pathname);
    var newFilePath = realPath + '/' + basename;

    request(downloadUrl, function(error, response, body){
        if (error) {
            res.send({});
            return;
        }

        fs.writeFileSync(newFilePath, body);
        res.send({});
    });
});

// Run server
var server = app.listen(8080, function(){
    console.log('Listening on port %d', server.address().port)
});