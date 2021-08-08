const api_func = require('../../Api_function.js');
const mongodb = require('models/mongodb');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const _ = require('lodash');
const dicomParser = require('dicom-parser');
const { getFrameImage, dcmtkSupportTransferSyntax } = require('../../../models/dcmtk/index');
let { getJpeg } = require('../../../models/python/index');
const sharp = require('sharp');
let DICOMWebHandleError = require('../../../models/DICOMWeb/httpMessage.js');

module.exports = async(req, res) => 
{
    try {
        let param = req.query;
        param = await api_func.Refresh_Param(param);
        if (!param.contentType) {
            param.contentType = 'image/jpeg';
        }
        if (param.requestType != "WADO") {
            return DICOMWebHandleError.sendBadRequestMessage(res , "Parameter error : requestType only allow WADO");
        } else if (param.contentType!= "image/jpeg" && param.contentType != "application/dicom") {
            return DICOMWebHandleError.sendBadRequestMessage(res , "Parameter error : contentType only allow image/jpeg or application/dicom");
        }
        res.setHeader('Content-Type' , param.contentType);
        let disk = process.env.DICOM_STORE_ROOTPATH;
        let ori_Path = await get_Instance_StorePath(param);
        if (!ori_Path) {
            return DICOMWebHandleError.sendNotFoundMessage(req , res);
        }
        let store_Path = `${disk}${ori_Path}`;
        if (!fs.existsSync(store_Path)) {
            return DICOMWebHandleError.sendNotFoundMessage(req , res);
        }

        if (param.contentType == 'image/jpeg') {
            if (param.frameNumber) {
                return await handleFrameNumber(param , res , store_Path);
            }
            //when user get DICOM without frame number, default return first frame image
            param.frameNumber = 1;
            return await handleFrameNumber(param , res , store_Path);
        } else {
            res.writeHead(200 , 
            {
                'Content-Type' : param.contentType ,
                'Content-Disposition' :'attachment; filename=' + path.basename(store_Path)
            });
            return fs.createReadStream(store_Path).pipe(res);
        }
    } catch (e) {
        console.error(e);
        if (e.message) {
            return DICOMWebHandleError.sendServerWrongMessage(res , e.message);    
        }
        return DICOMWebHandleError.sendServerWrongMessage(res , e);
    }
}
/**
 * 
 * @param {*} param 
 * @param {sharp.Sharp} imageSharp 
 */
function handleImageQuality (param, imageSharp) {
    if(param.imageQuality) {
        imageSharp = imageSharp.clone().jpeg({
            quality: param.imageQuality
        });
    }
}
/**
 * 
 * @param {*} param 
 * @param {sharp.Sharp} imageSharp 
 */
async function handleRegion(param, imageSharp) {
    if (param.region) {
        let [xMin , yMin ,xMax , yMax ] = param.region.split(",").map(v=> parseFloat(v));
        let imageMetadata = await imageSharp.metadata();
        let imageWidth = imageMetadata.width;
        let imageHeight = imageMetadata.height;
        let extractLeft = imageWidth * xMin;
        let extractTop = imageHeight * yMin;
        let extractWidth = imageWidth * xMax - extractLeft;
        let extractHeight = imageHeight * yMax - extractTop;
        imageSharp = imageSharp.extract({
            left: parseInt(extractLeft),
            top: parseInt(extractTop),
            width: parseInt(extractWidth),
            height: parseInt(extractHeight)
        });
    }
}
/**
 * 
 * @param {*} param 
 * @param {sharp.Sharp} imageSharp 
 */
async function handleRowsAndColumns(param, imageSharp) {
    let imageMetadata = await imageSharp.metadata();
    let rows = Number(param.rows);
    let columns = Number(param.columns);
    if (param.rows && param.columns) {
        imageSharp.resize(rows , columns , {
            fit: "fill"
        });
    } else if (param.rows) {
        imageSharp.resize(rows , imageMetadata.height, {
            fit: "fill"
        })
    } else if (param.columns) {
        imageSharp.resize(imageMetadata.width, columns, {
            fit: "fill"
        });
    }
}

async function handleFrameNumber (param , res , dicomFile) {
    try {
        if (!_.isNumber(param.frameNumber)) {
            return DICOMWebHandleError.sendBadRequestMessage(res, "Parameter error : frameNumber must be Number");
        } 
        if (param.contentType != "image/jpeg") {
            return DICOMWebHandleError.sendBadRequestMessage(res, "Parameter error : contentType only support image/jpeg with frameNumber");
        }
        let imageRelativePath = dicomFile.replace(process.env.DICOM_STORE_ROOTPATH,"");
        let images = `${process.env.DICOM_STORE_ROOTPATH}${imageRelativePath}`;
        let jpegFile = images.replace(/\.dcm\b/gi , `.${param.frameNumber-1}.jpg`);
        let finalJpegFile = "";
        if(fs.existsSync(jpegFile)) {
            finalJpegFile = jpegFile;
        } else {
            let dicomJson = await getDICOMJson(param);
            let transferSyntax = _.get(dicomJson ,"00020010.Value.0");
            if (!dcmtkSupportTransferSyntax.includes(transferSyntax)) {
                let pythonDICOM2JPEGStatus = await getJpeg[process.env.ENV]['getJpegByPydicom'](images);
                if (pythonDICOM2JPEGStatus) {
                    return fs.createReadStream(jpegFile).pipe(res);
                }
                res.set('content-type' , 'application/json');
                return DICOMWebHandleError.sendServerWrongMessage(res , `can't not convert dicom to jpeg with transfer syntax: ${transferSyntax}`); 
            }
            let frame = await getFrameImage(imageRelativePath, param.frameNumber);
            if (frame.status) {
                finalJpegFile = frame.imagePath;
            } else {
                res.set('content-type' , 'application/json');
                return DICOMWebHandleError.sendServerWrongMessage(res , `dcmtk Convert frame error ${frame.imageStream}`);
            }
        }
        let imageSharp = sharp(finalJpegFile);
        handleImageQuality(param, imageSharp);
        await handleRegion(param, imageSharp);
        await handleRowsAndColumns(param, imageSharp);
        return res.end(await imageSharp.toBuffer(), 'binary');
    } catch(e) {
        console.error(e);
        res.set('content-type' , 'application/json');
        return DICOMWebHandleError.sendServerWrongMessage(res , `${e.toString()}`);
    }
}

async function get_Instance_StorePath(i_Param)
{
    let aggregate_Query = 
    [
        {
            $match : {
                'dicomJson.0020000D.Value' : i_Param.studyUID, 
            }
        } ,
        {
            $unwind : '$series'
        },
		{
			$match :
			{
                'series.dicomJson.0020000E.Value' :i_Param.seriesUID ,
			}
        },
        {
            $match :
			{
                'series.instance.dicomJson.00080018.Value' :i_Param.objectUID
			}
        } ,
		{
			$project :
			{
				instance : 
				{
					$filter : 
					{
						input : '$series.instance' , 
						as : 'instance' , 
						cond : {$eq:[ '$$instance.uid' , i_Param.objectUID]}
					}
				}
			}
		}
	]
    let instance = await find_Aggregate_Func('ImagingStudy' ,aggregate_Query);
    if (instance.length <=0) return false;
    try {
        return (instance[0].instance[0].store_path);
    } catch (e) {
        console.log("getInstancePath error\r\n"+ JSON.stringify(aggregate_Query , null ,4));
        //console.log(aggregate_Query);
        return false;
    }
    
}

async function getDICOMJson(param) {
    let studyUID = param.studyUID;
    let seriesUID = param.seriesUID;
    let instanceUID = param.objectUID;

    let foundMetadata = await mongodb["dicomMetadata"].findOne({
        $and: [
            {
                studyUID: studyUID
            },
            {
                seriesUID: seriesUID
            },
            {
                instanceUID: instanceUID
            }
        ]
    }).exec();
    if (foundMetadata) return foundMetadata._doc;
    return false;
}

async function find_Aggregate_Func (collection_Name , i_Query)
{
    return new Promise(async (resolve , reject)=>
    {
        let agg =await mongodb[collection_Name].aggregate(
            i_Query);
        return resolve(agg);
    });
}