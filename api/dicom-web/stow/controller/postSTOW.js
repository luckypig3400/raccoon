const path = require('path');
const fs = require('fs');
const request = require('request');
const _ = require('lodash');

const FHIR_Imagingstudy_model = require("../../../../models/FHIR/DICOM2FHIRImagingStudy");
const { DCM2Endpoint_imagingStudy } = require("../../../../models/FHIR/DICOM2Endpoint");
const DCM2Patient = require('../../../../models/FHIR/DICOM2FHIRPatient');
const { putFHIRImagingStudyWithoutReq } = require('../../../FHIR/ImagingStudy/controller/putImagingStudy');

const sh = require('shorthash');
const fileFunc = require('../../../../models/file/file_Func');
const { QIDORetAtt } = require('../../../../models/FHIR/dicom-tag');

const { dcm2jpegCustomCmd, dcm2jsonV8, dcmtkSupportTransferSyntax, dcm2json } = require('../../../../models/dcmtk');
const moment = require('moment');
const formidable = require('../../../../models/formidable');
const { sendServerWrongMessage } = require('../../../../models/DICOMWeb/httpMessage');
const moveFile = require('move-file');
const uuid = require('uuid');
const { getJpeg } = require('../../../../models/python');
const mongodb = require('../../../../models/mongodb');
const { storeImagingStudy } = require('../../../FHIR/ImagingStudy/controller/post_convertFHIR');
const { getDeepKeys } = require('../../../Api_function');
const mkdirp = require('mkdirp');
const notImageSOPClass = require('../../../../models/DICOMWeb/notImageSOPClass');

//browserify
//https://github.com/node-formidable/formidable/blob/6baefeec3df6f38e34c018c9e978329ae68b4c78/src/Formidable.js#L496
//https://github.com/node-formidable/formidable/blob/6baefeec3df6f38e34c018c9e978329ae68b4c78/src/plugins/multipart.js#L47
//https://github.com/node-formidable/formidable/blob/6baefeec3df6f38e34c018c9e978329ae68b4c78/examples/multipart-parser.js#L13
async function dicom2mongodb(data) {
    return new Promise(async (resolve) => {
        let result = await putFHIRImagingStudyWithoutReq(data.id, data);
        if (result) return resolve(true);
        return resolve(false);
    });
}

async function dicom2FHIR(data) {
    return new Promise(async (resolve, reject) => {
        let resData = await storeImagingStudy(data.id, data);
        return resolve(resData);
    });
}

async function dicomEndpoint2MongoDB(data) {
    return new Promise((resolve, reject) => {
        let options =
        {
            method: "PUT",
            url: `http://${process.env.FHIRSERVER_HOST}:${process.env.SERVER_PORT}/api/fhir/Endpoint/${data.id}`,
            json: true,
            body: data
        }
        request(options, function (err, response, body) {
            if (err) {
                return reject(new Error(err));
            }
            return resolve(body);
        });
    });
}

async function dicomPatient2MongoDB(data) {
    return new Promise(async (resolve) => {
        let patient = DCM2Patient.DCMJson2Patient(data);
        let Insert_Patient_options = {
            url: `http://${process.env.FHIRSERVER_HOST}:${process.env.SERVER_PORT}/api/fhir/Patient/${patient.id}`,
            method: "PUT",
            json: true,
            body: patient
        }
        request(Insert_Patient_options, function (err, response, body) {
            if (err) {
                return resolve(false);
            }
            resolve(true);
        });
    });
}

async function generateJpeg(dicomJson, dicomFile, jpegFile) {
    try {
        console.time("generate jpeg");
        let studyUID = _.get(dicomJson, '0020000D.Value.0');
        let seriesUID = _.get(dicomJson, '0020000E.Value.0');
        let instanceUID = _.get(dicomJson, '00080018.Value.0');
        await insertDicomToJpegTask({
            studyUID: studyUID,
            seriesUID: seriesUID,
            instanceUID: instanceUID,
            status: false,
            message: "processing",
            taskTime: new Date()
        });
        let windowCenter = _.get(dicomJson, '00281050.Value.0');
        let windowWidth = _.get(dicomJson, '00281051.Value.0');
        let frameNumber = _.get(dicomJson, '00280008.Value.0', 1);
        let transferSyntax = _.get(dicomJson, "00020010.Value.0");
        let execCmd = "";
        let execCmdList = [];
        if (dcmtkSupportTransferSyntax.includes(transferSyntax)) {
            for (let i = 1; i <= frameNumber; i++) {
                if (process.env.ENV == "windows") {
                    if (windowCenter && windowWidth) {
                        execCmd = `models/dcmtk/dcmtk-3.6.5-win64-dynamic/bin/dcmj2pnm.exe --write-jpeg ${dicomFile} ${jpegFile}.${i - 1}.jpg --frame ${i} +Ww ${windowCenter} ${windowWidth}`;
                    } else {
                        execCmd = `models/dcmtk/dcmtk-3.6.5-win64-dynamic/bin/dcmj2pnm.exe --write-jpeg ${dicomFile} ${jpegFile}.${i - 1}.jpg --frame ${i}`;
                    }
                } else if (process.env.ENV == "linux") {
                    if (windowCenter && windowWidth) {
                        execCmd = `dcmj2pnm --write-jpeg ${dicomFile} ${jpegFile}.${i - 1}.jpg --frame ${i} +Ww ${windowCenter} ${windowWidth}`;
                    } else {
                        execCmd = `dcmj2pnm --write-jpeg ${dicomFile} ${jpegFile}.${i - 1}.jpg --frame ${i}`;
                    }
                }
                execCmdList.push(execCmd);
                if (i % 4 === 0) {
                    await Promise.all(execCmdList.map(cmd => dcm2jpegCustomCmd(cmd)))
                    execCmdList = new Array();
                }
            }
            console.timeEnd("generate jpeg");
        } else {
            for (let i = 1; i <= frameNumber; i++) {
                await getJpeg[process.env.ENV].getJpegByPydicom(dicomFile, i);
            }
            console.timeEnd("generate jpeg");
        }
        await insertDicomToJpegTask({
            studyUID: studyUID,
            seriesUID: seriesUID,
            instanceUID: instanceUID,
            status: true,
            message: "generated",
            finishedTime: new Date()
        });
    } catch (e) {
        await insertDicomToJpegTask({
            studyUID: studyUID,
            seriesUID: seriesUID,
            instanceUID: instanceUID,
            status: true,
            message: e.toString(),
            finishedTime: new Date()
        });
        console.error(e);
        throw e;
    }
}


/**
 * @typedef convertDICOMFileToJSONModuleReturnObject
 * @property {Boolean} status
 * @property {string} storePath
 * @property {string} storeFullPath
 * @property {Object} dicomJson
 */

/**
 * 
 * @param {string} filename 
 * @return {convertDICOMFileToJSONModuleReturnObject}
 */
async function convertDICOMFileToJSONModule(filename) {
    try {
        let dicomJson = await dcm2jsonV8.exec(filename);
        let perFrameFunctionalGroupSQ = _.get(dicomJson, "52009230");
        let tempPerFrameFunctionalGroupSQ = "";
        if (perFrameFunctionalGroupSQ) {
            tempPerFrameFunctionalGroupSQ = _.cloneDeep(perFrameFunctionalGroupSQ);
            dicomJson = _.omit(dicomJson, ["52009230"]);
            perFrameFunctionalGroupSQ = undefined;
        }
        let started_date = "";
        started_date = dcm2jsonV8.dcmString(dicomJson, '00080020') + dcm2jsonV8.dcmString(dicomJson, '00080030');
        started_date = moment(started_date, "YYYYMMDDhhmmss").toISOString();
        let started_date_split = started_date.split('-');
        let year = started_date_split[0];
        let month = started_date_split[1];
        let uid = dcm2jsonV8.dcmString(dicomJson, '0020000E');
        let shortUID = sh.unique(uid);
        let relativeStorePath = `files/${year}/${month}/${shortUID}/`;
        let fullStorePath = path.join(process.env.DICOM_STORE_ROOTPATH, relativeStorePath);

        let instanceUID = dcm2jsonV8.dcmString(dicomJson, '00080018')
        let metadataFullStorePath = path.join(fullStorePath, `${instanceUID}.metadata.json`);
        if (tempPerFrameFunctionalGroupSQ) {
            _.set(dicomJson, "52009230", tempPerFrameFunctionalGroupSQ);
        }
        fs.writeFileSync(metadataFullStorePath, JSON.stringify(dicomJson, null, 4));
        dicomJson = _.omit(dicomJson, ["52009230"]);
        return {
            status: true,
            storePath: relativeStorePath,
            storeFullPath: fullStorePath,
            dicomJson: dicomJson
        }
    } catch (e) {
        console.error(e);
        return {
            status: false,
            storePath: undefined,
            storeFullPath: undefined,
            dicomJson: undefined
        }
    }
}

/**
 * 
 * @typedef saveDICOMFileReturnObject
 * @property {Boolean} status
 * @property {string} storeFullPath
 * @property {Object} error
 */

/**
 * 
 * @param {string} tempFilename 
 * @param {string} filename 
 * @param {string} dest
 * @return {saveDICOMFileReturnObject}
 */
async function saveDICOMFile(tempFilename, filename, dest) {
    try {
        await fileFunc.mkdir_Not_Exist(dest);
        let destWithFilename = path.join(dest , filename);
        await moveFile(tempFilename, destWithFilename, {
            overwrite: true
        });
        return {
            status: true,
            error: undefined,
            storeFullPath: destWithFilename
        };
    } catch(e) {
        console.error(e);
        return {
            status: false,
            storeFullPath: undefined,
            error: e
        }
    }
}

async function saveUploadDicom(tempFilename, filename) {
    return new Promise(async (resolve, reject) => {
        try {
            let maxSize = 500 * 1024 * 1024;
            let fileSize = fs.statSync(tempFilename).size;
            let fhirData = "";
            let dcmJson = "";
            dcmJson = await dcm2jsonV8.exec(tempFilename);
            dcmJson = _.omit(dcmJson, ["52009230"]);
            if (_.isUndefined(newStoredFilename)) {
                return resolve(false);
            }
            if (fileSize > maxSize) {
                if (_.isString(tempFilename)) {
                    fhirData = await FHIR_Imagingstudy_model.DCMJson2FHIR(dcmJson);
                }
            } else {
                fhirData = await FHIR_Imagingstudy_model.DCM2FHIR(tempFilename).catch((err) => {
                    console.error(err);
                    fs.unlinkSync(tempFilename);
                    return resolve(false);
                });
            }
            if (!fhirData) {
                fs.unlinkSync(tempFilename);
                return resolve(false);
            }
            let newStoredFilename = await saveDICOMFile(fhirData, tempFilename, filename);
            if (_.isUndefined(newStoredFilename)) {
                return resolve(false);
            }
            fhirData = await getFHIRIntegrateDICOMJson(dcmJson, newStoredFilename, fhirData);
            return resolve(fhirData);
        } catch(e) {
            console.error(e)
            resolve(false);
        }
    });
}

async function replaceBinaryData(data) {
    try {
        let keys = getDeepKeys(data);
        let binaryKeys = [];
        for (let key of keys) {
            if (key.includes("7FE00010")) continue;
            let keyData = _.get(data, key);
            if (keyData == "OW" || keyData == "OB") {
                binaryKeys.push(key.substring(0 , key.lastIndexOf(".vr")));
            }
        }
        let port = process.env.DICOMWEB_PORT || "";
        port = (port) ? `:${port}` : "";
        for (let key of binaryKeys) {
            let instanceUID = _.get(data, `00080018.Value.0`);
            let binaryData = "";

            let shortInstanceUID = sh.unique(instanceUID);
            let relativeFilename = `files/bulkData/${shortInstanceUID}/`;
            if (_.get(data, `${key}.Value.0`) ) {
                binaryData = _.get(data, `${key}.Value.0`);
                data = _.omit(data, [`${key}.Value`]);
                _.set(data, `${key}.BulkDataURI`, `http://${process.env.DICOMWEB_HOST}${port}/api/dicom/instance/${instanceUID}/bulkData/${key}.Value.0`);
                relativeFilename += `${ key }.Value.0.raw`
            } else if (_.get(data, `${key}.InlineBinary`)) {
                binaryData = _.get(data, `${key}.InlineBinary`);
                data = _.omit(data, [`${key}.InlineBinary`]);
                _.set(data, `${key}.BulkDataURI`, `http://${process.env.DICOMWEB_HOST}${port}/api/dicom/instance/${instanceUID}/bulkData/${key}.InlineBinary`);
                relativeFilename += `${key}.InlineBinary.raw`
            }

            
            let filename = path.join(process.env.DICOM_STORE_ROOTPATH, relativeFilename);
            mkdirp.sync(path.join(process.env.DICOM_STORE_ROOTPATH, `files/bulkData/${shortInstanceUID}`));
            fs.writeFileSync(filename, binaryData);
            let bulkData = {
                instanceUID: instanceUID,
                filename: relativeFilename,
            }

            await mongodb["dicomBulkData"].updateOne({
                $and: [
                    {
                        instanceUID: instanceUID
                    },
                    {
                        filename: new RegExp(relativeFilename, "gi")
                    }
                ]
            }, bulkData , {
                upsert: true
            });
            
            
            
        }

    } catch(e) {
        console.error(e);
        throw e;
    }
}

function insertMetadata(metadata) {
    return new Promise(async (resolve) => {
        try {
            await replaceBinaryData(metadata);
            await mongodb.dicomMetadata.updateOne({
                'studyUID': metadata.studyUID,
                'seriesUID': metadata.seriesUID,
                'instanceUID': metadata.instanceUID
            }, metadata, {
                upsert: true
            });
            return resolve(true);
        } catch (e) {
            console.error(e);
            throw e;
        }
    });
}

async function insertDicomToJpegTask(item) {
    return new Promise(async (resolve) => {
        try {
            await mongodb.dicomToJpegTask.updateOne({
                'studyUID': item.studyUID,
                'seriesUID': item.seriesUID,
                'instanceUID': item.instanceUID
            }, item, {
                upsert: true
            })
            resolve(true);
        } catch (e) {
            console.error(e);
            resolve(false);
        }
    });
}

async function getFHIRIntegrateDICOMJson(dicomJson , filename, fhirData) {
    try {
        let isNeedParsePatient = process.env.FHIR_NEED_PARSE_PATIENT == "true";
        let endPoint = DCM2Endpoint_imagingStudy(fhirData);
        await dicomEndpoint2MongoDB(endPoint);
        if (isNeedParsePatient) {
            await dicomPatient2MongoDB(dicomJson);
        }
        fhirData.endpoint = {
            reference: `Endpoint/${endPoint.id}`,
            type: "Endpoint"
        }
        delete dicomJson["7fe00010"];
        let jpegFile = filename.replace(/\.dcm/gi, '');
        let sopClass = dcm2jsonV8.dcmString(dicomJson, "00080016");
        if (!notImageSOPClass.includes(sopClass)) {
            generateJpeg(dicomJson, filename, jpegFile);
        }
        
        let QIDOLevelKeys = Object.keys(QIDORetAtt);
        let QIDOAtt = Object.assign({}, QIDORetAtt);
        for (let i = 0; i < QIDOLevelKeys.length; i++) {
            let levelTags = Object.keys(QIDORetAtt[QIDOLevelKeys[i]]);
            for (let x = 0; x < levelTags.length; x++) {
                let nowLevelKeyItem = QIDOAtt[QIDOLevelKeys[i]];
                let setValueTag = levelTags[x];
                if (dicomJson[setValueTag]) {
                    nowLevelKeyItem[setValueTag] = dicomJson[setValueTag];
                } else {
                    if (!_.isObject(nowLevelKeyItem[setValueTag])) {
                        delete nowLevelKeyItem[setValueTag];
                    }
                }
            }
        }
        //QIDOAtt.instance = dicomJson;
        let port = process.env.DICOMWEB_PORT || "";
        port = (port) ? `:${port}` : "";
        QIDOAtt.study['00081190'] = {
            vr: "UT",
            Value: [`http://${process.env.DICOMWEB_HOST}${port}/${process.env.DICOMWEB_API}/studies/${QIDOAtt.study['0020000D'].Value[0]}`]
        }
        fhirData['dicomJson'] = QIDOAtt.study;
        QIDOAtt.series['00081190'] = {
            vr: "UT",
            Value: [`http://${process.env.DICOMWEB_HOST}${port}/${process.env.DICOMWEB_API}/studies/${QIDOAtt.study['0020000D'].Value[0]}/series/${QIDOAtt.series['0020000E'].Value[0]}`]
        }
        fhirData.series[0].dicomJson = QIDOAtt.series;
        QIDOAtt.instance['00081190'] = {
            vr: "UT",
            Value: [`http://${process.env.DICOMWEB_HOST}${port}/${process.env.DICOMWEB_API}/studies/${QIDOAtt.study['0020000D'].Value[0]}/series/${QIDOAtt.series['0020000E'].Value[0]}/instances/${QIDOAtt.instance['00080018'].Value[0]}`]
        }
        fhirData.series[0].instance[0].dicomJson = QIDOAtt.instance;
        dicomJson["7FE00010"] = {
            "vr": "OW",
            "BulkDataURI": `http://${process.env.DICOMWEB_HOST}${port}/${process.env.DICOMWEB_API}/studies/${QIDOAtt.study['0020000D'].Value[0]}/series/${QIDOAtt.series['0020000E'].Value[0]}/instances/${QIDOAtt.instance['00080018'].Value[0]}`
        }

        //fhirData.series[0].instance[0].metadata = dicomJson;
        for (let i in fhirData.dicomJson["00080020"].Value) {
            fhirData.dicomJson["00080020"].Value[i] = moment(fhirData.dicomJson["00080020"].Value[i], "YYYYMMDD").toDate();
        }
        let metadata = _.cloneDeep(dicomJson);
        _.set(metadata, 'studyUID', metadata["0020000D"].Value[0]);
        _.set(metadata, 'seriesUID', metadata["0020000E"].Value[0]);
        _.set(metadata, 'instanceUID', metadata["00080018"].Value[0]);
        await insertMetadata(metadata);
        return fhirData;
    } catch (e) {
        console.error(e);
        return false;
    }
}
/* Failure Reason
http://dicom.nema.org/medical/dicom/current/output/chtml/part02/sect_J.4.2.html
A7xx - Refused out of Resources

    The STOW-RS Service did not store the instance because it was out of resources.
A9xx - Error: Data Set does not match SOP Class

    The STOW-RS Service did not store the instance because the instance does not conform to its specified SOP Class.
Cxxx - Error: Cannot understand

    The STOW-RS Service did not store the instance because it cannot understand certain Data Elements.
C122 - Referenced Transfer Syntax not supported

    The STOW-RS Service did not store the instance because it does not support the requested Transfer Syntax for the instance.
0110 - Processing failure

    The STOW-RS Service did not store the instance because of a general failure in processing the operation.
0122 - Referenced SOP Class not supported

    The STOW-RS Service did not store the instance because it does not support the requested SOP Class. 
 */
function getSOPSeq(referencedSOPClassUID, referencedSOPInstanceUID) {
    let result = {
        "00081150": {
            vr: "UI",
            Value: [referencedSOPClassUID]
        },
        "00081155": {
            vr: "UI",
            Value: [referencedSOPInstanceUID]
        }
    }
    return result;
}


function checkIsSameStudyId(req, dicomJson) {
    let inputID = req.params.studyID;
    let dataStudyID = dcm2jsonV8.dcmString(dicomJson, "0020000D");
    return inputID == dataStudyID;
}

module.exports = async (req, res) => {
    //store the successFiles;
    let successFiles = [];
    let successFHIR = [];
    let STOWMessage = {
        "00081190": {  //Study retrive URL
            "vr": "UT",
            "Value": []
        },
        "00081198": {  //Failed SOP Sequence
            "vr": "SQ",
            "Value": [] // Use SOPSeq
        },
        "00081199": { //ReferencedSOPSequence
            "vr": "SQ",
            "Value": [] // Use SOPSeq
        }
    }
    let retCode = 200;
    console.time("Processing STOW");

    new formidable.IncomingForm({
        uploadDir: path.join(process.cwd(), "/temp"),
        maxFileSize: 100 * 1024 * 1024 * 1024,
        multiples: true,
        isGetBoundaryInData: true
    }).parse(req, async (err, fields, files) => {
        if (err) {
            console.error(err);
            return sendServerWrongMessage(res, err);
        } else {
            let fileField = Object.keys(files).pop();
            let uploadedFiles = files[fileField];
            if (!_.isArray(uploadedFiles)) uploadedFiles = [uploadedFiles];
            //main-process
            try {
                //if env FHIR_NEED_PARSE_PATIENT is true then post the patient data
                for (let i = 0; i < uploadedFiles.length; i++) {
                    if (!uploadedFiles[i].name) uploadedFiles[i].name = `${uuid.v4()}.dcm`;
                    //1. convert DICOM to JSON
                    let dicomToJsonResponse = await convertDICOMFileToJSONModule(uploadedFiles[i].path);
                    if (!dicomToJsonResponse.status) {
                        return sendServerWrongMessage(res, `The server have exception with file:${uploadedFiles[i].name} , error : can not convert DICOM to JSON Module, success Files: ${JSON.stringify(successFiles , null ,4)}`);
                    }

                    let sopClass = dcm2jsonV8.dcmString(dicomToJsonResponse.dicomJson, "00080016");
                    let sopInstanceUID = dcm2jsonV8.dcmString(dicomToJsonResponse.dicomJson, "00080018");
                    let sopSeq = getSOPSeq(sopClass, sopInstanceUID);
                    if (req.params.studyID) {
                        if (!checkIsSameStudyId(req, fhirDICOM)) {
                            let failureMessage = {
                                "00081197": {
                                    vr: "US",
                                    Value: ["A900"]
                                }
                            }
                            Object.assign(sopSeq, failureMessage);
                            STOWMessage["00081198"].Value.push(sopSeq);
                            retCode = 409;
                            continue;
                        }
                    }
                    //2. if not conflict study UID or no exception when convert to DICOM
                    //then save DICOM file
                    let storedDICOMObject = await saveDICOMFile(uploadedFiles[i].path, uploadedFiles[i].name,  dicomToJsonResponse.storeFullPath);
                    if (storedDICOMObject.status) {
                        //3. Convert DICOM to FHIR ImagingStudy
                        let fhirImagingStudyData = await FHIR_Imagingstudy_model.DCMJson2FHIR(dicomToJsonResponse.dicomJson);
                        if (!fhirImagingStudyData) {
                            return sendServerWrongMessage(res, `The server have exception with file:${uploadedFiles[i].name} , error : can not convert DICOM to FHIR ImagingStudy`);
                        }
                        let fhirDICOM = await getFHIRIntegrateDICOMJson(dicomToJsonResponse.dicomJson, storedDICOMObject.storeFullPath, fhirImagingStudyData);
                        if (!fhirDICOM) {
                            return sendServerWrongMessage(res, `The server have exception with file:${uploadedFiles[i].name} , error : can not integrate FHIR with DICOM JSON`);
                        }

                        fhirDICOM.series[0].instance[0].store_path = path.join(dicomToJsonResponse.storePath, uploadedFiles[i].name);

                        let port = process.env.DICOMWEB_PORT || "";
                        port = (port) ? `:${port}` : "";
                        STOWMessage["00081190"].Value.push(...fhirDICOM.dicomJson["00081190"].Value);
                        STOWMessage["00081190"].Value = _.uniq(STOWMessage["00081190"].Value);
                        let retriveInstanceUrl = {
                            "00081190": fhirDICOM.series[0].instance[0].dicomJson["00081190"]
                        }
                        Object.assign(sopSeq, retriveInstanceUrl);
                        STOWMessage["00081199"]["Value"].push(sopSeq);
                        let FHIRmerge = await dicom2FHIR(fhirDICOM);

                        if (!FHIRmerge) {
                            return sendServerWrongMessage(res, `The server have exception with file:${uploadedFiles[i].name} , error : can not store FHIR ImagingStudy object to database`);
                        }

                        let storeToMongoDBStatus = await dicom2mongodb(FHIRmerge);
                        if (!storeToMongoDBStatus) {
                            return sendServerWrongMessage(res, `The server have exception with file:${uploadedFiles[i].name} , error : can not store object to database`);
                        }
                        let baseFileName = path.basename(uploadedFiles[i].name);
                        successFHIR.push(baseFileName);
                        successFiles.push(baseFileName);
                    } else {
                        return sendServerWrongMessage(res, `The server have exception with file:${uploadedFiles[i].name} , error : ${storedDICOMObject.error.toString()}`);
                    }
                    
                }
                res.header("Content-Type", "application/json");
                let resMessage = {
                    result: successFiles,
                    successFHIR: successFHIR
                }
                Object.assign(resMessage, STOWMessage);
                console.timeEnd("Processing STOW");
                return res.status(retCode).send(resMessage);
            } catch (err) {
                err = err.message || err;
                console.error('/dicom-web/studies "STOW Api" err, ', err);
                console.log(successFiles);
                return res.status(500).send(err)
            }
        }
    });
}



module.exports.STOWWithoutRoute = async (filename) => {
    try {
        let dicomToJsonResponse = await convertDICOMFileToJSONModule(filename);
        if (!dicomToJsonResponse.status) {
            console.error(`The server have exception with file:${filename} , error : can not convert DICOM to JSON Module`);
            return false;
        }

        let storedDICOMObject = await saveDICOMFile(filename, path.basename(filename), dicomToJsonResponse.storeFullPath);
        if (storedDICOMObject.status) {
            let fhirImagingStudyData = await FHIR_Imagingstudy_model.DCMJson2FHIR(dicomToJsonResponse.dicomJson);
            if (!fhirImagingStudyData) {
                consol.error(`The server have exception with file:${filename} , error : can not convert DICOM to FHIR ImagingStudy`);
                return false;
            }
            let fhirDICOM = await getFHIRIntegrateDICOMJson(dicomToJsonResponse.dicomJson, storedDICOMObject.storeFullPath, fhirImagingStudyData);
            if (!fhirDICOM) {
                console.error(`The server have exception with file:${filename} , error : can not integrate FHIR with DICOM JSON`);
                return false;
            }
            fhirDICOM.series[0].instance[0].store_path = path.join(dicomToJsonResponse.storePath, path.basename(filename));

            let FHIRmerge = await dicom2FHIR(fhirDICOM);
            if (!FHIRmerge) {
                console.error(`The server have exception with file:${filename} , error : can not store FHIR ImagingStudy object to database`);
                return false;
            }

            let storeToMongoDBStatus = await dicom2mongodb(FHIRmerge);
            if (!storeToMongoDBStatus) {
                console.error(`The server have exception with file:${filename} , error : can not store object to database`);
                return false;
            }
            return true;
        } else {
            console.error(`The server have exception with file:${filename} , error : can not convert DICOM to JSON Module`);
            return false;
        }
    } catch (err) {
        err = err.message || err;
        console.log('/dicom-web/studies "STOW Api" err, ', err);
        return false;
    }
}
