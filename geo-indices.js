const R = require('ramda')
const IndexedGeo = require('indexed-geo')

function toFeature (object) {
  if (object.geometry) {
    return {
      type: 'Feature',
      properties: R.omit(['geometry'], object),
      geometry: object.geometry
    }
  }
}

function isBuildingPolygon (object) {
  return object.type === 'st:Building' && object.geometry && object.geometry.type === 'Polygon'
}

function isBuildingToponym (object) {
  return object.type === 'st:Building' && object.geometry && object.geometry.type === 'Point'
}

module.exports = function () {
  let indices = {}

  function index (object) {
    if (isBuildingPolygon(object)) {
      const layerId = object.data.layerId

      if (!indices[layerId]) {
        const indexedGeo = IndexedGeo()
        indices[layerId] = indexedGeo
      }

      indices[layerId].index(toFeature(object))
    }
  }

  function inside (object) {
    if (isBuildingToponym(object)) {
      const layerId = object.data.layerId

      const indexedGeo = indices[layerId]

      if (!indexedGeo) {
        throw new Error(`No geospatial index found for map layer ${layerId}`)
      }

      return indexedGeo.inside(object.geometry)
    }
  }

  return {
    index,
    inside
  }
}
