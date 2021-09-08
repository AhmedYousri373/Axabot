const init = require('../../config/init');
const Hosts = require('../../models/hosts');
const notifier = require('../notifier');


const fs = require('fs');
const request = require('request');

const Queue = require('bull');
const uploadQueue = new Queue('uploadQueue');


var fileUpload = function (job, io) {
    if (!(this instanceof fileUpload)) return new fileUpload(job, io);

    this.job = job;
    this.io = io || global.io;

    this.uploadInfo = "http://nitroflare.com/plugins/fileupload/getServer";

    this.server = 'nitroflare.com';
    this.host = 'nitroflare.com';
    this.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.12; rv:49.0) Gecko/20100101 Firefox/49.0";


    var data = job.data;
    var infos = data.infos;

    this.jobId = job.id;
    this.taskId = data.taskId;
    this.type = infos.type;
    this.filePath = infos.path; 
    this._key = infos._key;
    this.filename = infos.filename;
    this.filenameRD = infos.filenameRD;
    this.size = 0;
    this.fileStat = {};
    this.link = infos.link;
    this.error = infos.error;
    this._hash = null;
    this.uploadServer = null;
    this.uploaded = 0;
    this.useAccount = true;
    this.time_start = (new Date()).getTime();

}

fileUpload.prototype._getServer = function () {
    var _this = this;
    return new Promise(function (resolve, reject) {
        var opts = {
            method: 'GET',
            url: _this.uploadInfo,
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.12; rv:49.0) Gecko/20100101 Firefox/49.0",
                "Host": _this.host,
                'cache-control': 'no-cache',
                "Connection": "keep-alive"
            }
        };

        request(opts, function (err, response, body) {
            if (err || response.statusCode != 200) {
                return reject(`Please verify ${_this.host} maybe is down!`)
            }

            if (!body.match(/^(http(s)?):\/\//ig)) {
                console.log('Nitroflare Invalid Link type ', body);
                return reject("Invalid Link type..");
            } else {
                _this.uploadServer = body;
                return resolve();
            }
        })
    })
}


fileUpload.prototype.datainit = function () {
    var _this = this;
    return new Promise(function (resolve, reject) {
        Hosts.findOne({
            'server': _this.server
        }, 'data', function (err, _result) {
            if (err || !_result) return reject('Cannot find Host data, Verify the host account.');

            var result = _result.data || {};
            _this._hash = result.hash;

            if (result.use_account == false || !_this._hash) {
                return reject("*Please verify your credentials.");
            } else {
                _this._getServer().then(resolve).catch(reject);
            }
        })
    })
}




fileUpload.prototype.send = function () {
    var _this = this;
    return new Promise(function (resolve, reject) {
        if (!_this._hash) return reject("*Please verify Hash, it's missing.");

        if (!_this.uploadServer) {
            return reject('No upload server Found');
        }

        var fileStream = fs.createReadStream(_this.filePath);

        var opts = {
            method: 'POST',
            url: _this.uploadServer,
            headers: {
                'User-Agent': _this.userAgent,
                "Content-Type": "multipart/form-data",
                "Connection": "Keep-Alive"
            },
            forever: true,
            pool: {
                maxSockets: Infinity
            }
        };

        var r = request(opts).on('error', function (error) {
            if (error && error.code == 'ENOENT') return reject('File Check Error.');
            if (error && error.code == 'ECONNRESET') return reject('Upload Aborted (Request Closed).'); 
        }).on('end', function () {

            if (_this.intID) {
                clearInterval(_this.intID);
            }
            r.agent.destroy();
        }).on('response', function (response) {
           
            response.on('data', function (data) {
                data = data ? data.toString() : null;

                if (!data) {
                    return reject("Cannot find upload link.");
                } else {
                    var error = null;
                    try {
                        data = JSON.parse(data);
                        files = data.files ? data.files[0] : [];
                        _this.link = files['url'];
                    } catch (e) {
                        error = "Error parsing Received Data";
                    }

                    if (data && data['error'] || files && files['error']) {
                        return reject("Host reject Upload with \"Internal error, please retry\" ");
                    } else if (error) {
                        return reject(error);
                    } else if (!_this.link || !_this.link.match(/^(http(s)?):\/\//ig)) {
                        return reject("Invalid Url type..");
                    } else {
                        return resolve();
                    }
                }
            })
        })

        uploadQueue.getJob(_this.jobId).then(function (_job) {
            if (!_job) {
                r.agent.destroy();
                
                return reject('Upload Cancelled.');
            }
        })

        var time_start = _this.time_start;
        var fspeed = _this.fspeed = 0;
        var festim = _this.festim = 0;
        var uploaded = _this.uploaded = 0;

        _this.progress = 0;
        _this.size = 0;
        _this.intID;

        var form = r.form();
        form.append('user', _this._hash);
        form.append('files', fileStream, {
            filename: _this.filenameRD
        });

        form.getLength(function (err, size) {
            _this.size = size;
            _this.intID = setInterval(function () {

                let _progress = {
                    jobId: _this.jobId,
                    taskId: _this.taskId,
                    host: _this.host,
                    mdoing: 'Uploading....',
                    status: 'running',
                    progress: _this.progress,
                    uploaded: _this.bulklng,
                    fspeed: _this.fspeed,
                    est: _this.est,
                    fullSize: _this.fullSize,
                    byteSize: _this.size,
                };

                _this.job.progress(_progress);
            }, init._emitInterval);
        });

        form.on('data', function (data) {
            uploaded += data.length;

            var toSoFar = (((new Date()).getTime() - time_start) * 0.001).toFixed(3);
            fspeed = Math.round(uploaded / toSoFar);
            festim = Math.round(((_this.size - uploaded) * toSoFar) / uploaded);
            _this.est = init.convertSeconds(festim);

            if (fspeed > _this.size) {
                fspeed = data.length;
            }

            _this.fspeed = init.bytesToSize(fspeed).all + '/s';
            _this.bulklng = init.bytesToSize(uploaded).all;

            progress = ((uploaded / _this.size) * 100);

            _this.progress = progress ? progress.toFixed() : 0;

            _this.fullSize = init.bytesToSize(_this.size).all;

        });

        var evntNm = 'abortupload';
        notifier.on(evntNm, function (data) {
            var jobId = data.jobId || '';
            if (jobId && jobId == _this.jobId) {
                r.agent.destroy();
                
                if (_this.intID) clearInterval(_this.intID);
                return reject('Upload Cancelled.');
            }
        })

    })
}

fileUpload.prototype.process = function (callback) {
    var _this = this;

    _this.datainit().then(function () {
        return _this.send();
    }).then(function () {

        var _ndupload = {
            jobId: _this.jobId,
            taskId: _this.taskId,
            host: _this.host,
            mdoing: null,
            status: 'finished',
            progress: 100,
            uploaded: _this.bulklng,
            fspeed: _this.fspeed,
            fullSize: _this.fullSize,
            byteSize: _this.size,
            link: _this.link
        };

        _this.job.progress(_ndupload);

        if (_this.intID) {
            clearInterval(_this.intID);
        }

        return callback(null, _ndupload);

    }).catch(function (error) {

        var _errupload = {
            jobId: _this.jobId,
            taskId: _this.taskId,
            host: _this.host,
            mdoing: null,
            status: 'aborted',
            progress: _this.progress,
            uploaded: _this.bulklng,
            fspeed: _this.fspeed,
            fullSize: _this.fullSize,
            byteSize: _this.size,
            error: init.clearErrors(error)
        };

        _this.job.progress(_errupload);

        if (_this.intID) {
            clearInterval(_this.intID);
        }

        return callback(error);
    })
}

module.exports = fileUpload