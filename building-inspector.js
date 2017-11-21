const fs = require('fs')
const crypto = require('crypto')
const path = require('path')
const got = require('got')
const async = require('async')
const H = require('highland')
const JSONStream = require('JSONStream')
const base62 = require('base-62.js')

const GeoIndices = require('./geo-indices')

const baseUrl = 'http://buildinginspector.nypl.org/api/'

const GOT_OPTIONS = {
  timeout: 25 * 1000,
  retries: 5,
  json: true
}

const MAPWARPER_DATASET = 'mapwarper'

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

function requestCallback (sleep, url, callback) {
  got(url, GOT_OPTIONS)
    .then((response) => {
      if (sleep) {
        setTimeout(() => {
          callback(null, response.body)
        }, sleep)
      } else {
        callback(null, response.body)
      }
    })
    .catch(callback)
}

function allPagesToFile (baseUrl, paginated, filename, onPage, callback) {
  if (paginated) {
    const writeStream = H()

    writeStream.flatten()
      .pipe(JSONStream.stringify('{\n"type":"FeatureCollection","features":[', '\n,\n', '\n]}\n'))
      .pipe(fs.createWriteStream(filename))

    let page = 0
    let nextPage
    async.doWhilst(
      function (callback) {
        page += 1
        const url = baseUrl + '/page/' + page
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
      () => nextPage, // && page < 2
      (err) => {
        writeStream.end()
        callback(err)
      })
  } else {
    got.stream(baseUrl, Object.assign(GOT_OPTIONS, {json: false}))
      .pipe(fs.createWriteStream(filename))
      .on('finish', callback)
      .on('error', callback)
  }
}

const consolidatedCache = {}

function convertConsolidated (sheetsById, layersById, feature) {
  const buildingId = feature.properties.id

  if (consolidatedCache[buildingId]) {
    return
  }
  consolidatedCache[buildingId] = true

  const mapId = parseInt(feature.properties.map_id)
  const sheet = sheetsById[feature.properties.sheet_id]
  const layerId = sheet.properties.layer.external_id
  const year = parseInt(sheet.properties.layer.year)
  const borough = layersById[layerId] && layersById[layerId].borough

  let objects = [
    {
      type: 'object',
      obj: {
        id: buildingId,
        type: 'st:Building',
        validSince: year,
        validUntil: year,
        data: {
          sheetId: feature.properties.sheet_id,
          layerId,
          mapId,
          colors: feature.properties.consensus_color ? feature.properties.consensus_color.split(',') : undefined,
          borough
        },
        geometry: feature.geometry.geometries[0]
      }
    },
    ...mapwarperRelations(buildingId, mapId, layerId)
  ]

  if (!borough) {
    objects.push({
      type: 'log',
      obj: {
        error: `Can\'t find borough for layer ${layerId}`
      }
    })
  }

  if (feature.geometry.geometries[0].coordinates[0].length < 4) {
    return []
  }

  if (feature.properties.consensus_address !== 'NONE') {
    feature.properties.consensus_address.forEach((address, i) => {
      const addressId = `${buildingId}-${i + 1}`

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
              layerId: layerId,
              mapId: mapId,
              borough
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

function mapwarperRelations (id, mapId, layerId) {
  return [
    {
      type: 'relation',
      obj: {
        type: 'st:in',
        from: id,
        to: `${MAPWARPER_DATASET}/${mapId}`
      }
    },
    {
      type: 'relation',
      obj: {
        type: 'st:in',
        from: id,
        to: `${MAPWARPER_DATASET}/layer-${layerId}`
      }
    }
  ]
}

const toponymsCache = {}

function convertToponyms (sheetsById, layersById, feature) {
  const hash = crypto.createHash('md5').update(feature.geometry.coordinates.join(',')).digest('hex')
  const sheetId = feature.properties.sheet_id
  const toponymId = `toponym-${sheetId}-${base62.encodeHex(hash)}`

  if (toponymsCache[toponymId]) {
    return
  }
  toponymsCache[toponymId] = true

  const sheet = sheetsById[sheetId]
  const layerId = sheet.properties.layer.external_id
  const mapId = parseInt(sheet.properties.map_id)
  const year = parseInt(sheet.properties.layer.year)
  const borough = layersById[layerId] && layersById[layerId].borough

  let logs = []
  if (!borough) {
    logs = [{
      type: 'log',
      obj: {
        error: `Can\'t find borough for layer ${layerId}`
      }
    }]
  }

  return [
    {
      type: 'object',
      obj: {
        id: toponymId,
        type: 'st:Building',
        validSince: year,
        validUntil: year,
        name: feature.properties.consensus,
        data: {
          sheetId,
          layerId,
          mapId,
          borough
        },
        geometry: feature.geometry
      }
    },
    ...mapwarperRelations(toponymId, mapId, layerId),
    ...logs
  ]
}

function convertAndIndexBuildings (filename, convert, params) {
  const geoIndices = GeoIndices()

  return new Promise((resolve, reject) => {
    convertGeoJSON(filename, convert, params)

      .map((data) => {
        geoIndices.index(data.obj)
        return data
      })
      .map(H.curry(params.writer.writeObject))
      .nfcall([])
      .series()
      .stopOnError(reject)
      .done(() => {
        resolve(geoIndices)
      })
  })
}

function convertAndIntersect (filename, convert, params) {
  const geoIndices = params.geoIndices

  return new Promise((resolve, reject) => {
    convertGeoJSON(filename, convert, params)
      .map((data) => {
        let log
        let relations = []

        try {
          const results = geoIndices.inside(data.obj)

          if (results) {
            if (results.length) {
              relations = results.map((feature) => ({
                type: 'relation',
                obj: {
                  from: data.obj.id,
                  to: feature.properties.id,
                  type: 'st:sameAs'
                }
              }))
            } else {
              log = {
                type: 'log',
                obj: {
                  error: `Can\'t find building for toponym ${data.obj.id}`
                }
              }
            }
          }
        } catch (err) {
          log = {
            type: 'log',
            obj: {
              error: `Error computing intersection for toponym ${data.obj.id}`
            }
          }
        }

        return [data, log, ...relations]
      })
      .flatten()
      .compact()
      .map(H.curry(params.writer.writeObject))
      .nfcall([])
      .series()
      .stopOnError(reject)
      .done(resolve)
  })
}

function convertGeoJSON (filename, convert, params) {
  const stream = fs.createReadStream(filename)
    .pipe(JSONStream.parse('features.*'))

  return H(stream)
    .map(H.curry(convert, params.sheets, params.layers))
    .compact()
    .flatten()
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
  let sheets
  let sheetsById = {}

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

  let layers = require(path.join(__dirname, 'layer-boroughs.json'))
  let layersById = {}

  layers.forEach((layer) => {
    layersById[layer.id] = layer
  })

  const params = {
    sheets: sheetsById,
    layers: layersById,
    writer: tools.writer
  }

  const filenameConsolidated = path.join(dirs.download, 'consolidated.geojson')
  const filenameToponyms = path.join(dirs.download, 'toponyms.geojson')

  convertAndIndexBuildings(filenameConsolidated, convertConsolidated, params)
    .then((geoIndices) => {
      return convertAndIntersect(filenameToponyms, convertToponyms, Object.assign(params, {
        geoIndices
      }))
    })
    .then(callback)
    .catch(callback)
}

// ==================================== API ====================================

module.exports.steps = [
  download,
  transform
]
