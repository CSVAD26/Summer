// https://inspirit.github.io/jsfeat/sample_oflow_lk.html
//modified voronoi example that uses video point tracking

var cnv;
var capture;
var curpyr, prevpyr, pointCount, pointStatus, prevxy, curxy;
var w = 640,
    h = 480;
var maxPoints = 1000;
let points = [];
let delaunay, voronoi;
let showVoronoi = true;
let showDelaunay = false;


function setup() {
    capture = createCapture({
        audio: false,
        video: {
            width: w,
            height: h
        }
    }, function () {
        console.log('capture ready.')
    });
    capture.elt.setAttribute('playsinline', '');
    cnv = createCanvas(w, h);
    capture.size(w, h);
    capture.hide();

    curpyr = new jsfeat.pyramid_t(3);
    prevpyr = new jsfeat.pyramid_t(3);
    curpyr.allocate(w, h, jsfeat.U8C1_t);
    prevpyr.allocate(w, h, jsfeat.U8C1_t);

    pointCount = 0;
    pointStatus = new Uint8Array(maxPoints);
    prevxy = new Float32Array(maxPoints * 2);
    curxy = new Float32Array(maxPoints * 2);
    updateTriangulation();

}

function keyPressed(key) {
    for (var i = 0; i < 100; i++) {
        addPoint(random(width), random(height));
    }
    updateTriangulation();
}

function mousePressed() {
    addPoint(mouseX, mouseY);
}

function addPoint(x, y) {
    if (pointCount < maxPoints) {
        var pointIndex = pointCount * 2;
        curxy[pointIndex] = x;
        curxy[pointIndex + 1] = y;
        pointCount++;

    }
}

function prunePoints() {
    var outputPoint = 0;
    for (var inputPoint = 0; inputPoint < pointCount; inputPoint++) {
        if (pointStatus[inputPoint] == 1) {
            if (outputPoint < inputPoint) {
                var inputIndex = inputPoint * 2;
                var outputIndex = outputPoint * 2;
                curxy[outputIndex] = curxy[inputIndex];
                curxy[outputIndex + 1] = curxy[inputIndex + 1];
            }
            outputPoint++;
        }
    }
    pointCount = outputPoint;
}

function draw() {
    image(capture, 0, 0, w, h);
    capture.loadPixels();
    if (capture.pixels.length > 0) { // don't forget this!
        var xyswap = prevxy;
        prevxy = curxy;
        curxy = xyswap;
        var pyrswap = prevpyr;
        prevpyr = curpyr;
        curpyr = pyrswap;

        // these are options worth breaking out and exploring
        var winSize = 20;
        var maxIterations = 30;
        var epsilon = 0.01;
        var minEigen = 0.001;

        jsfeat.imgproc.grayscale(capture.pixels, w, h, curpyr.data[0]);
        curpyr.build(curpyr.data[0], true);
        jsfeat.optical_flow_lk.track(
            prevpyr, curpyr,
            prevxy, curxy,
            pointCount,
            winSize, maxIterations,
            pointStatus,
            epsilon, minEigen);
        prunePoints();

        for (var i = 0; i < pointCount; i++) {
            var pointOffset = i * 2;
            // ellipse(curxy[pointOffset], curxy[pointOffset + 1], 8, 8);
            points.push([curxy[pointOffset], curxy[pointOffset + 1]]);
        }
        updateTriangulation();
        

        if (points.length >2){
        // Draw Delaunay
        if (showDelaunay) {
            stroke(255, 150);
            strokeWeight(1);
            noFill();
            for (let tri of delaunay.trianglePolygons()) {
                beginShape();
                for (let [x, y] of tri) vertex(x, y);
                endShape(CLOSE);
            }
        }

        // Draw Voronoi
        if (showVoronoi) {
            stroke(0);
            strokeWeight(1);
            for (let cell of voronoi.cellPolygons()) {
                let c = averageCellColor(cell);
                fill(c[0], c[1], c[2]);
                beginShape();
                for (let [x, y] of cell) vertex(x, y);
                endShape(CLOSE);
            }
        }
    }
    points = [];
    }


    drawInstructions();

}


function drawInstructions() {
    noStroke();
    fill(255);
    textSize(14);
    text('V: Toggle Voronoi | D: Toggle Delaunay', 10, height - 10);
}

function updateTriangulation() {
    if (points.length < 3) return;
    delaunay = d3.Delaunay.from(points);
    voronoi = delaunay.voronoi([0, 0, width, height]);
}

// average the webcam color at 16 random points inside a voronoi cell
function averageCellColor(cell) {
    var minX = width, minY = height, maxX = 0, maxY = 0;
    for (let [x, y] of cell) {
        minX = min(minX, x); minY = min(minY, y);
        maxX = max(maxX, x); maxY = max(maxY, y);
    }
    var r = 0, g = 0, b = 0, n = 0, tries = 0;
    while (n < 16 && tries < 1000) { // tries cap guards against degenerate cells
        tries++;
        var x = random(minX, maxX);
        var y = random(minY, maxY);
        if (!pointInPolygon(x, y, cell)) continue;
        var px = constrain(floor(x), 0, w - 1);
        var py = constrain(floor(y), 0, h - 1);
        var pixelIndex = 4 * (py * w + px);
        r += capture.pixels[pixelIndex];
        g += capture.pixels[pixelIndex + 1];
        b += capture.pixels[pixelIndex + 2];
        n++;
    }
    if (n == 0) return [0, 0, 0];
    return [r / n, g / n, b / n];
}

// ray-casting point-in-polygon test
function pointInPolygon(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var xi = poly[i][0], yi = poly[i][1];
        var xj = poly[j][0], yj = poly[j][1];
        if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}
