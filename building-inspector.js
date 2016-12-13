'use strict'

const fs = require('fs')
const crypto = require('crypto')
const path = require('path')
const request = require('request')
const async = require('async')
const H = require('highland')
const JSONStream = require('JSONStream')

const baseUrl = 'http://buildinginspector.nypl.org/api/'

const createPromise = (fun, ...args) => {
  return new Promise((resolve, reject) => {
    const callback = (err, ...args) => {
      if (!err) {
        resolve.apply(this, [...args])
      } else {
        reject(err)
      }
    }

    fun.apply(this, [...args, callback])
  })
}

var requestCallback = function (sleep, url, callback) {
  request(url, (err, response, body) => {
    if (err) {
      callback(err)
    } else {
      if (sleep) {
        setTimeout(() => {
          callback(null, JSON.parse(body))
        }, sleep)
      } else {
        callback(null, JSON.parse(body))
      }
    }
  })
}

var allPagesToFile = function (baseUrl, paginated, filename, onPage, callback) {
  if (paginated) {
    var writeStream = H()

    writeStream.flatten()
      .pipe(JSONStream.stringify('{\n"type":"FeatureCollection","features":[', '\n,\n', '\n]}\n'))
      .pipe(fs.createWriteStream(filename))

    var page = 0
    var nextPage
    async.doWhilst(
      function (callback) {
        page += 1
        var url = baseUrl + '/page/' + page
        requestCallback(1000, url, (err, json) => {
          if (onPage) {
            onPage(err, page, url, json)
          }

          if (json && json.features && json.features.length > 0) {
            nextPage = true
            writeStream.write(json.features)
          } else {
            nextPage = false
          }

          callback(err)
        })
      },
      () => {
        return nextPage // && page < 2
      },
      (err) => {
        writeStream.end()
        callback(err)
      })
  } else {
    request(baseUrl)
      .pipe(fs.createWriteStream(filename))
      .on('finish', callback)
  }
}

function convertConsolidated (sheetsById, feature) {
  var buildingId = feature.properties.id

  const sheet = sheetsById[feature.properties.sheet_id]
  const year = parseInt(sheet.properties.layer.year)

  var objects = [
    {
      type: 'object',
      obj: {
        id: buildingId,
        type: 'st:Building',
        validSince: year,
        validUntil: year,
        data: {
          sheetId: feature.properties.sheet_id,
          layerId: sheet.properties.layer_id,
          mapId: parseInt(feature.properties.map_id),
          color: feature.properties.consensus_color
        },
        geometry: feature.geometry.geometries[0]
      }
    }
  ]

  if (feature.geometry.geometries[0].coordinates[0].length < 4) {
    return []
  }

  if (feature.properties.consensus_address !== 'NONE') {
    feature.properties.consensus_address.forEach((address, i) => {
      var addressId = `${buildingId}-${i + 1}`

      objects.push(
        {
          type: 'object',
          obj: {
            id: addressId,
            type: 'st:Address',
            validSince: year,
            validUntil: year,
            name: address.flag_value,
            data: {
              number: address.flag_value,
              sheetId: feature.properties.sheet_id,
              layerId: sheet.properties.layer_id,
              mapId: parseInt(feature.properties.map_id)
            },
            geometry: feature.geometry.geometries[i + 1]
          }
        }
      )

      objects.push(
        {
          type: 'relation',
          obj: {
            from: addressId,
            to: buildingId,
            type: 'st:in'
          }
        }
      )
    })
  }

  return objects
}

function convertToponyms (sheetsById, feature) {
  var hash = crypto.createHash('md5').update(feature.geometry.coordinates.join(',')).digest('hex')

  const sheetId = feature.properties.sheet_id
  const sheet = sheetsById[sheetId]
  const year = parseInt(sheet.properties.layer.year)

  return [{
    type: 'object',
    obj: {
      id: `toponym-${sheetId}-${hash}`,
      type: 'st:Building',
      validSince: year,
      validUntil: year,
      name: feature.properties.consensus,
      data: {
        sheetId,
        layerId: sheet.properties.layer_id,
        mapId: parseInt(sheet.properties.map_id)
      },
      geometry: feature.geometry
    }
  }]
}

function convertGeoJSON (sheetsById, dir, writer, file, callback) {
  var stream = fs.createReadStream(path.join(dir, file.filename))
    .pipe(JSONStream.parse('features.*'))

  H(stream)
    .map(H.curry(file.convert, sheetsById))
    .compact()
    .flatten()
    .map(H.curry(writer.writeObject))
    .nfcall([])
    .series()
    .stopOnError(callback)
    .done(callback)
}

function download (config, dirs, tools, callback) {
  const onPage = (err, page, url) => {
    if (err) {
      console.error(`      Error downloading ${url}`)
    } else {
      console.log(`      Downloaded ${url}`)
    }
  }

  const allPagesPromise = (name, paginated) => createPromise(allPagesToFile, `${baseUrl}${name}`, paginated, path.join(dirs.current, `${name}.geojson`), onPage)

  // Download three Building Inspector datasets:
  //   - http://buildinginspector.nypl.org/api/consolidated/page/:page
  //   - http://buildinginspector.nypl.org/api/toponyms
  //   - http://buildinginspector.nypl.org/api/sheets/

  allPagesPromise('consolidated', true)
    .then(() => {
      console.log('      Done downloading consolidated polygons!')
      return allPagesPromise('toponyms', false)
    })
    .then(() => {
      console.log('      Done downloading toponyms!')
      return allPagesPromise('sheets', false)
    })
    .then(() => {
      console.log('      Done downloading sheets!')
      callback()
    })
    .catch((err) => {
      callback(err)
    })
}

function transform (config, dirs, tools, callback) {
  // First, load all sheets, needed for linking objects to layers
  var sheets
  var sheetsById = {}

  try {
    sheets = JSON.parse(fs.readFileSync(path.join(dirs.download, 'sheets.geojson')))
  } catch (err) {
    console.error('    Cannot load sheets.geojson')
    callback(err)
    return
  }

  sheets.features.forEach((sheet) => {
    sheetsById[sheet.properties.id] = sheet
  })

  var files = [
    {
      filename: 'consolidated.geojson',
      convert: convertConsolidated
    },
    {
      filename: 'toponyms.geojson',
      convert: convertToponyms
    }
  ]

  H(files)
    .map(H.curry(convertGeoJSON, sheetsById, dirs.download, tools.writer))
    .nfcall([])
    .series()
    .stopOnError(callback)
    .done(callback)
}

// ==================================== API ====================================

module.exports.steps = [
  download,
  transform
]
