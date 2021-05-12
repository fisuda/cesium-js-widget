/*
 * Cesium.js widget
 * https://github.com/lets-fiware/cesium-js-widget
 *
 * Copyright (c) 2021 Kazuhito Suda
 * Licensed under Apache-2.0 License
 */

/* globals MashupPlatform, StyledElements*/

import {
    Cartesian3,
    Cesium3DTileStyle,
    Cesium3DTileset,
    Color,
    Credit,
    CustomDataSource,
    Ellipsoid,
    HeadingPitchRange,
    Ion,
    Math,
    OpenStreetMapImageryProvider,
    PinBuilder,
    Rectangle,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    Transforms,
    VerticalOrigin,
    Viewer,
} from 'cesium';

import "../css/styles.css";
import "cesium/Build/Cesium/Widgets/widgets.css";
import * as turf from '@turf/turf';
import { JapanGSITerrainProvider, JapanGSIImageryProvider } from '@lets-fiware/cesium-japangsi';

"use strict";

export default function CesiumJs() {
    this.pois = {};
    this.queue = [];
    this.executingCmd = '';
    this.waiting = false;
    this.debug = MashupPlatform.prefs.get('debug');

    MashupPlatform.prefs.registerCallback(function (new_preferences) {
    }.bind(this));
};

const TITLE_MAP_STYLES = {
    OSM: {
        title: 'Open Street Map',
        attributions: '© <a href="http://osm.org/copyright">OpenStreetMap</a> contributors, <a href="http://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA</a>',
        url: 'https://tile.openstreetmap.org/'
    },
    GSI_STD: {
        title: 'GSI STD',
        attributions: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">Geospatial Information Authority of Japan Tile</a>',
        url: "https://cyberjapandata.gsi.go.jp/xyz/std/",
        minZoomLevel: 2,
        maxZoomLevel: 18,
    },
    GSI_PALE: {
        title: 'GSI PALE',
        attributions: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">Geospatial Information Authority of Japan Tile</a>',
        url: '//cyberjapandata.gsi.go.jp/xyz/pale/',
        minZoomLevel: 5,
        maxZoomLevel: 18,
    },
    GSI_ENG: {
        title: 'GSI ENGLISH',
        attributions: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">Geospatial Information Authority of Japan Tile</a>',
        url: '//cyberjapandata.gsi.go.jp/xyz/english/',
        minZoomLevel: 5,
        maxZoomLevel: 11,
    },
    GSI_BLANK: {
        title: 'GSI BLANK',
        attributions: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">Geospatial Information Authority of Japan Tile</a>',
        url: '//cyberjapandata.gsi.go.jp/xyz/blank/',
        minZoomLevel: 5,
        maxZoomLevel: 14,
    },
    GSI_RELIEF: {
        title: 'GSI RELIEF',
        attributions: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">Geospatial Information Authority of Japan Tile</a>',
        url: '//cyberjapandata.gsi.go.jp/xyz/relief/',
        minZoomLevel: 5,
        maxZoomLevel: 15,
    },
};

CesiumJs.prototype.init = function init() {
    let initialPosition = MashupPlatform.prefs.get('initialPosition').split(',').map(Number);
    if (initialPosition.length != 3
        || !Number.isFinite(initialPosition[0])
        || !Number.isFinite(initialPosition[1])
        || !Number.isFinite(initialPosition[2])) {
        if (MashupPlatform.context.get('language') == 'ja') {
            initialPosition = [138, 30, 3000000];
        } else {
            initialPosition = [0 ,35, 3000000];
        }
    }

    let initialOrientation = MashupPlatform.prefs.get('initialOrientation').split(',').map(Number);
    if (initialOrientation.length != 3
        || !Number.isFinite(initialOrientation[0])
        || !Number.isFinite(initialOrientation[1])
        || !Number.isFinite(initialOrientation[2])) {
        initialOrientation = [0, -1.3, 0];
    }

    Ion.defaultAccessToken = MashupPlatform.prefs.get('token');

    const options = {
        animation: MashupPlatform.prefs.get('animation'),
        baseLayerPicker: MashupPlatform.prefs.get('baseLayerPicker'),
        fullscreenButton: MashupPlatform.prefs.get('fullscreenButton'),
        geocoder: MashupPlatform.prefs.get('geocoder'),
        homeButton: MashupPlatform.prefs.get('homeButton'),
        timeline: MashupPlatform.prefs.get('timeline'),
        navigationHelpButton: MashupPlatform.prefs.get('navigationHelpButton'),
        sceneModePicker: MashupPlatform.prefs.get('sceneModePicker'),
    }

    const style = MashupPlatform.prefs.get('mapStyle');
    if (style != 'OFF') {
        const raster_tile = new OpenStreetMapImageryProvider({
            url: TITLE_MAP_STYLES[style].url,
            credit: new Credit(TITLE_MAP_STYLES[style].attributions, true),
            maximumLevel: 18,
        });
        options.imageryProvider = raster_tile;
    }

    this.viewer = new Viewer("cesiumContainer", options)

    this.viewer.camera.setView({
        destination: Cartesian3.fromDegrees(initialPosition[0], initialPosition[1], initialPosition[2]),
        orientation: {
            heading: initialOrientation[0],
            pitch: initialOrientation[1],
            roll: initialOrientation[2]
        }
    });

    this.pinBuilder = new PinBuilder();
    this.scratchRectangle = new Rectangle();

    this.intervalHandler = setInterval(() => {
        if (this.isMoving) {
            sendPoIList.call(this);
        }
    }, 100)

    this.isMoving = false;

    this.viewer.camera.moveStart.addEventListener(() => {
        this.isMoving = true;
    });
    this.viewer.camera.moveEnd.addEventListener(() => {
        this.isMoving = false;
    });

    this.screenSpaceEventHandler = new ScreenSpaceEventHandler(this.viewer.canvas);
    // sendSelectedPoI
    this.screenSpaceEventHandler.setInputAction(e => {
        if (MashupPlatform.widget.outputs.poiOutput.connected) {
            const picked = this.viewer.scene.pick(e.position);
            if (picked) {
                const feature = this.pois[picked.id.id];
                if (feature) {
                    MashupPlatform.widget.outputs.poiOutput.pushEvent(feature);
                } else {
                    const feature = this.pois[picked.id.entityCollection.owner.name];
                    if (feature) {
                        MashupPlatform.widget.outputs.poiOutput.pushEvent(feature);
                    }
                }
            }
        }
    },
    ScreenSpaceEventType.LEFT_CLICK
    );

    // Porting of https://github.com/Wirecloud/ol3-map-widget
    // Set position button
    const setposition_button = document.getElementById('setposition-button');
    setposition_button.addEventListener('click', (event) => {
        const pos = this.viewer.camera.position;
        const carto = Ellipsoid.WGS84.cartesianToCartographic(pos);
        const long = Math.toDegrees(carto.longitude);
        const lat = Math.toDegrees(carto.latitude);
        MashupPlatform.prefs.set(
            'initialPosition',
            long + ', ' + lat + ', ' + carto.height
        );
    });
    const setorientation_button = document.getElementById('setorientation-button');
    setorientation_button.addEventListener('click', (event) => {
        MashupPlatform.prefs.set(
            'initialOrientation',
            this.viewer.camera.heading + ', ' + this.viewer.camera.pitch + ', ' + this.viewer.camera.roll
        );
    });
    const setlocation_button = document.getElementById('setlocaton-button');
    setlocation_button.addEventListener('click', (event) => {
        const pos = this.viewer.camera.position;
        const carto = Ellipsoid.WGS84.cartesianToCartographic(pos);
        const long = Math.toDegrees(carto.longitude);
        const lat = Math.toDegrees(carto.latitude);
        MashupPlatform.prefs.set(
            'initialPosition',
            long + ', ' + lat + ', ' + carto.height
        );
        MashupPlatform.prefs.set(
            'initialOrientation',
            this.viewer.camera.heading + ', ' + this.viewer.camera.pitch + ', ' + this.viewer.camera.roll
        )
    });
    const update_ui_buttons = (changes) => {
        // Use strict equality as changes can not contains changes on the
        // editing parameter
        if (changes.editing === true) {
            setposition_button.classList.remove('hidden');
            setorientation_button.classList.remove('hidden');
            setlocation_button.classList.remove('hidden');
        } else if (changes.editing === false) {
            setposition_button.classList.add('hidden');
            setorientation_button.classList.add('hidden');
            setlocation_button.classList.add('hidden');
        }
    };
    MashupPlatform.mashup.context.registerCallback(update_ui_buttons);
    update_ui_buttons({editing: MashupPlatform.mashup.context.get('editing')});

    // Create a table mapping class name to unicode.
    this.glyphTable = {};
    for (let i = 0; i < window.top.document.styleSheets.length; i++) {
        const sheet = document.styleSheets[i];
        if (sheet && 'href' in sheet && sheet.href != null
            && sheet.href.endsWith('fontawesome.min.css')) {
            const before = '::before';
            for (let i = 0; i < sheet.cssRules.length; i++) {
                const cssRule = sheet.cssRules[i];
                if (cssRule.selectorText && cssRule.selectorText.endsWith(before)) {
                    // const ctx = '\\u' + cssRule.style.content.replace(/'|"/g, '').charCodeAt(0).toString(16);
                    const ctx = cssRule.style.content.slice(1).slice(0, -1);
                    this.glyphTable[cssRule.selectorText.slice(1).slice(0, -1 * before.length)] = ctx;
                }
            }
        }
    }
}

CesiumJs.prototype.addLayer = function addLayer(command_info) {
    // Not yet implemented
}

CesiumJs.prototype.moveLayer = function moveLayer(command_info) {
    // Not yet implemented
}

CesiumJs.prototype.removeLayer = function removeLayer(command_info) {
    // Not yet implemented
}

CesiumJs.prototype.setBaseLayer = function setBaseLayer(command_info) {
    // Not yet implemented
}

CesiumJs.prototype.registerPoIs = function registerPoIs(pois_info) {
    pois_info.forEach(poi => registerPoI.call(this, poi, true));
    sendPoIList.call(this);
}

CesiumJs.prototype.replacePoIs = function replacePoIs(pois_info) {
    this.viewer.entities.removeAll();
    this.pois = {};

    pois_info.forEach(poi => registerPoI.call(this, poi, false));
    sendPoIList.call(this);
}

CesiumJs.prototype.centerPoI = function centerPoI(poi_info) {
    const features = poi_info.map(poi => registerPoI.call(this, poi, true));
    if (poi_info.length > 1 || (poi_info.length == 1 && poi_info[0].location.type != 'Point')) {
        const box = turf.envelope(turf.featureCollection(features)).bbox;
        const rect = new Rectangle();
        Rectangle.fromDegrees(box[0], box[1], box[2], box[3], rect);
        this.viewer.camera.flyTo({
            destination: rect
        });
    } else {
        this.viewer.flyTo(this.viewer.entities.getById(poi_info[0].id));
    }
    sendPoIList.call(this);
}

CesiumJs.prototype.removePoIs = function removePoIs(pois_info) {
    pois_info.forEach(poi => {
        removePoi.call(this, poi);
        delete this.pois[poi.id];
    });
    sendPoIList.call(this);
}

const registerPoI = function registerPoI(poi, update) {
    removePoi.call(this, poi);
    if (!poi.data) {
        poi.data = {};
    }
    const style = (poi.style) ? poi.style : {}
    if (!style.fontSymbol) {
        style.fontSymbol = {}
    }
    if (!style.fill) {
        style.fill = {}
    }
    switch (poi.location.type) {
    case 'Point':
        this.viewer.entities.add(buildPoint.call(this, poi, style));
        break;
    case 'MultiPoint':
        this.viewer.dataSources.add(buildMultiPoint.call(this, poi, style));
        break;
    case 'LineString':
        this.viewer.entities.add(buildLineString(poi, style))
        break;
    case 'MultiLineString':
        this.viewer.dataSources.add(buildMultiLineString(poi, style));
        break;
    case 'Polygon':
        this.viewer.entities.add(buildPolygon(poi, style))
        break;
    case 'MultiPolygon':
        this.viewer.dataSources.add(buildMultiPolygon(poi, style));
        break;
    default:
        MashupPlatform.widget.log(`Unknown type: ${poi.location.type}, id: ${poi.id}`, MashupPlatform.log.INFO);
        return;
    }
    this.pois[poi.id] = poi;

    return getFeature(poi);
}

const removePoi = function removePoi(poi) {
    if (!this.pois[poi.id]) {
        return;
    }
    const e = this.viewer.entities.getById(poi.id);
    if (e != null) {
        this.viewer.entities.remove(e);
    } else {
        const e = this.viewer.dataSources.getByName(poi.id)
        if (e != null) {
            this.viewer.dataSources.remove(e[0], true);
        }
    }
}

const fontAwesomeIcon = function fontAwesomeIcon(style) {
    style.glyph = 'fa-utensils';
    const unicode = this.glyphTable[style.glyph];

    const canvas = window.top.document.createElement("canvas");
    canvas.width  = 56;
    canvas.height = 56;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);

    /*
    this.radius_ = 20;
    const c = 1;
    const w = 1;
    const s = 5;
    context.beginPath();
    context.arc ( c, c -0.4*this.radius_, 0.6*this.radius_, 0.15*Math.PI, 0.85*Math.PI, true);
    context.lineTo ( c-0.89*0.05*s, (0.95+0.45*0.05)*s+w);
    context.arc ( c, 0.95*s+w, 0.05*s, 0.85*Math.PI, 0.15*Math.PI, true);
    context.fill();
    context.fillStyle = "red";
    context.beginPath();
    context.moveTo(75, 50);
    context.lineTo(100, 75);
    context.lineTo(100, 25);
    context.fill();
    */
    /*
    context.save();
    context.fillStyle = '#FF0000';
    context.lineWidth = 0.846;
    context.beginPath();
    context.moveTo(6.72, 0.422);
    context.lineTo(17.28, 0.422);
    context.bezierCurveTo(18.553, 0.422, 19.577, 1.758, 19.577, 3.415);
    context.lineTo(19.577, 10.973);
    context.bezierCurveTo(19.577, 12.63, 18.553, 13.966, 17.282, 13.966);
    context.lineTo(14.386, 14.008);
    context.lineTo(11.826, 23.578);
    context.lineTo(9.614, 14.008);
    context.lineTo(6.719, 13.965);
    context.bezierCurveTo(5.446, 13.983, 4.422, 12.629, 4.422, 10.972);
    context.lineTo(4.422, 3.416);
    context.bezierCurveTo(4.423, 1.76, 5.447, 0.423, 6.718, 0.423);
    context.closePath();
    context.fill();
    context.stroke();
    context.restore();
    */
    // context.arc(24, 24, 22, 0, 360, false);
    context.beginPath();
    context.arc(24, 24, 22,  25 * Math.PI / 180,  155 * Math.PI / 180, true);
    context.moveTo(3.6, 33.2);
    context.lineTo (24, 54);
    context.lineTo(44.4, 33.2);
    context.fillStyle = "blue";
    context.fill();
    context.strokeStyle = "white" ;
    context.lineWidth = 4;
    context.stroke();

    context.font = '600 24px "Font Awesome 5 Free"';
    // context.font = '48px FontAwesome';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = '#00FF00';
    context.fillStyle = "white";
    // context.strokeText(unicode, 24, 24);
    context.fillText(unicode, 24, 24);

    return canvas.toDataURL( "image/png" , 1.0 );
}

const buildPoint = function buildPoint(poi, style) {
    let image;
    if  ('icon' in poi) {
        image = ((typeof poi.icon === 'string') ? poi.icon : poi.icon.src)
    } else {
        style.fontSymbol.glyph = style.fontSymbol.glyph || 'fa-star';
        style.fontSymbol.color = style.fontSymbol.color || Color.GREEN;
        style.fontSymbol.size = style.fontSymbol.size || 48;
        
        if (style.fontSymbol.glyph.startsWith('fa-')) {
            image = fontAwesomeIcon.call(this, style.fontSymbol);
        } else {
            image = this.pinBuilder.fromMakiIconId(
                style.fontSymbol.glyph,
                style.fontSymbol.color,
                style.fontSymbol.size);
        }
    }


    return {
        id: poi.id,
        position: Cartesian3.fromDegrees(poi.location.coordinates[0], poi.location.coordinates[1]),
        billboard: {
            image: image,
            verticalOrigin: VerticalOrigin.BOTTOM,
        },
        description: poi.infoWindow || poi.tooltip || ''
    };
}

const buildMultiPoint = function buildMultiPoint(poi, style) {
    const image = ('icon' in poi)
        ? ((typeof poi.icon === 'string') ? poi.icon : poi.icon.src)
        : this.pinBuilder.fromMakiIconId(
            style.fontSymbol.glyph || 'star',
            style.fontSymbol.color || Color.GREEN,
            style.fontSymbol.size || 48);

    const ds = new CustomDataSource(poi.id);
    for (let point of poi.location.coordinates) {
        ds.entities.add({
            name: poi.data.name || 'no name',
            position: Cartesian3.fromDegrees(point[0], point[1]),
            billboard: {
                image: image,
                verticalOrigin: VerticalOrigin.BOTTOM,
            },
            description: ''
        })
    }
    return ds;
}

const buildLineString = function buildLineString(poi, style) {
    const coordinates = [];
    for (let p of poi.location.coordinates) {
        coordinates.push(p[0]);
        coordinates.push(p[1]);
    }
    return {
        id: poi.id,
        name: poi.data.name || '',
        description: '',
        polyline: { // Cesium.PolylineGraphics.ConstructorOptions
            positions: Cartesian3.fromDegreesArray(coordinates),
            width: style.stroke.width || 3,
            material: Color.RED,
        }
    }
}

const buildMultiLineString = function buildMultiLineString(poi, style) {
    const ds = new CustomDataSource(poi.id);
    for (let line of poi.location.coordinates) {
        const coordinates = [];
        for (let p of line) {
            coordinates.push(p[0]);
            coordinates.push(p[1]);
        }
        ds.entities.add({
            name: poi.data.name || '',
            description: '',
            polyline: { // Cesium.PolylineGraphics.ConstructorOptions
                positions: Cartesian3.fromDegreesArray(coordinates),
                width: style.stroke.width || 3,
                material: Color.RED,
            }
        });
    }
    return ds;
}

const buildPolygon = function buildPolygon(poi, style) {
    const coordinates = [];
    for (let p of poi.location.coordinates[0]) { // only no holes
        coordinates.push(p[0]);
        coordinates.push(p[1]);
    }
    return {
        id: poi.id,
        name: poi.data.name || '',
        description: '',
        polygon: { // Cesium.PolygonGraphics.ConstructorOptions
            hierarchy: Cartesian3.fromDegreesArray(coordinates),
            height: poi.height || 0,
            material: style.fill.color || Color.BLUE.withAlpha(0.1),
            outline: true,
            outlineColor: style.fill.outlineColor || Color.BLUE,
            outlineWidth: style.fill.outlineWidth || 5,
        }
    }
}

const buildMultiPolygon = function buildMultiPolygon(poi, style) {
    const ds = new CustomDataSource(poi.id);
    for (let polygon of poi.location.coordinates) {
        const coordinates = [];
        for (let p of polygon[0]) { // only no holes
            coordinates.push(p[0]);
            coordinates.push(p[1]);
        }
        ds.entities.add({
            name: poi.data.name || '',
            description: '',
            polygon: { // Cesium.PolygonGraphics.ConstructorOptions
                hierarchy: Cartesian3.fromDegreesArray(coordinates),
                height: poi.height || 0,
                material: style.fill.color || Color.BLUE.withAlpha(0.1),
                outline: true,
                outlineColor: style.fill.outlineColor || Color.BLUE,
                outlineWidth: style.fill.outlineWidth || 5,
            }
        });
    }
    return ds;
}

CesiumJs.prototype.execCommands = function (commands) {
    _execCommands.call(this, commands, this.executingCmd);
}

// =========================================================================
// PRIVATE MEMBERS
// =========================================================================
const sendPoIList = function sendPoIList() {
    if (MashupPlatform.widget.outputs.poiListOutput.connected) {
        const rect = this.viewer.camera.computeViewRectangle(this.viewer.scene.globe.ellipsoid, this.scratchRectangle);
        const w = Math.toDegrees(rect.west).toFixed(4);
        const s = Math.toDegrees(rect.south).toFixed(4);
        const e = Math.toDegrees(rect.east).toFixed(4);
        const n = Math.toDegrees(rect.north).toFixed(4);
        const bbox = turf.polygon([[[w, n], [e, n], [e, s], [w, s], [w, n]]]);
        let poiList = [];
        for (let key in this.pois) {
            let poi = this.pois[key];
            if (turf.booleanIntersects(getFeature(poi), bbox)) {
                poiList.push(poi.data);
            }
        };
        MashupPlatform.widget.outputs.poiListOutput.pushEvent(poiList);
    }
}

const getFeature = function getFeature(poi) {
    if (!poi.hasOwnProperty('__feature')) {
        switch (poi.location.type) {
        case 'Point':
            poi.__feature = turf.point(poi.location.coordinates);
            break;
        case 'MultiPoint':
            poi.__feature = turf.multiPoint(poi.location.coordinates);
            break;
        case 'LineString':
            poi.__feature = turf.lineString(poi.location.coordinates);
            break;
        case 'MultiLineString':
            poi.__feature = turf.multiLineString(poi.location.coordinates);
            break;
        case 'Polygon':
            poi.__feature = turf.polygon(poi.location.coordinates);
            break;
        case 'MultiPolygon':
            poi.__feature = turf.multiPolygon(poi.location.coordinates);
            break;
        }
    }
    return poi.__feature;
}

const _execCommands = function _execCommands(commands, _executingCmd) {
    if (!this.waiting) {
        this.executingCmd = _executingCmd;
        if (!Array.isArray(commands)) {
            commands = [commands];
        }
        this.queue = this.queue.concat(commands);

        if (this.executingCmd == '' && this.queue.length > 0) {
            let cmd = this.queue.shift();
            if (!cmd.hasOwnProperty('value')) {
                cmd.value = {}
            }
            if (cmd.type != null) {
                this.executingCmd = cmd.type.toLowerCase();
                if (commandList[this.executingCmd] != null) {
                    commandList[this.executingCmd].call(this, cmd.value);
                } else {
                    MashupPlatform.widget.log(`${this.executingCmd} not found`, MashupPlatform.log.INFO);
                    this.executingCmd = ''
                }
            }
        }
    }
    this.debug && MashupPlatform.widget.log(`exec: ${this.executingCmd}, queue: ${this.queue.length}`, MashupPlatform.log.INFO);
}

const execEnd = function execEnd() {
    setTimeout(() => {
        _execCommands.call(this, [], '');
    }, 0);
};

const commandList = {
    'add3dtileset': function (value) {
        if (value.longitude != null && value.latitude != null) {
            this.viewer.camera.setView({
                destination: Cartesian3.fromDegrees(value.longitude, value.latitude, value.height || 0.0)
            })
        }

        const tileset = this.viewer.scene.primitives.add(
            new Cesium3DTileset({
                url: value.url
            })
        )

        tileset.style = new Cesium3DTileStyle({
            pointSize: value.pointSize || 5
        })

        this.viewer.zoomTo(tileset)

        execEnd.call(this);
    },
    'setView': function (value) {
        this.viewer.camera.setView({
            destination: Cartesian3.fromDegrees(
                value.longitude,
                value.latitude,
                value.height || 0.0,
                value.ellipsoid || 'Ellipsoid.WGS84')
        })
        execEnd.call(this);
    },
    'flyto': function (value) {
        this.viewer.camera.flyTo({
            destination: Cartesian3.fromDegrees(
                value.longitude,
                value.latitude,
                value.height || 0.0
            )
        })
        execEnd.call(this);
    },
    'rotatecamera': function (value) {
        // Lock camera to a point
        const center = Cartesian3.fromDegrees(value.longitude, value.latitude, value.height);
        const transform = Transforms.eastNorthUpToFixedFrame(center);
        this.viewer.scene.camera.lookAtTransform(transform, new HeadingPitchRange(0, -Math.PI / 8, 2900));

        // Orbit this point
        this. viewer.clock.onTick.addEventListener(clock => {
            this. viewer.scene.camera.rotateRight(0.005);
        });
        execEnd.call(this);
    },
    'addgsiprovider': function (value) {
        this.viewer.imageryLayers.removeAll();
        this.viewer.imageryLayers.addImageryProvider(
            new JapanGSIImageryProvider(
                value.imagery || { layerLists: ["ort","relief","std"] }
            )
        );
        this.viewer.terrainProvider = new JapanGSITerrainProvider(
            value.terrain || {}
        );
        execEnd.call(this);
    },
    'addgsiimageryprovider': function (value) {
        this.viewer.imageryLayers.removeAll();
        this.viewer.imageryLayers.addImageryProvider(
            new JapanGSIImageryProvider(
                value.imagery || { layerLists: ["ort","relief","std"] }
            )
        );
        execEnd.call(this);
    },
    'addgsiterrainprovider': function (value) {
        this.viewer.terrainProvider = new JapanGSITerrainProvider(
            value.terrain || {}
        );
        execEnd.call(this);
    },
}
