/*************************************************************
 * Title: Canopy Height Modeling using GEDI & Sentinel-2
 * Author: htamiminia
 * Date: March 2023
 * Description: Combines GEDI RH95 with Sentinel-2 bands and
 *               vegetation indices to train a Random Forest 
 *               regression model for estimating CHM.
 *************************************************************/
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 1. Import Assets & Visualization Setup
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Define the region of interest (ROI) as New York State boundary
var ROI = table;

// Center the map view on the ROI for visualization
Map.centerObject(ROI);

//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 2. Import Preprocessed Sentinel-2 Composite
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Load the preprocessed Sentinel-2 image for New York State (June–September 2019)
// Preprocessing applied using `s2_preprocessing.js` (available in my GitHub repository)
//  - Cloud masking
//  - Reflectance scaling
//  - Median composite for target period
//  - Clipping to ROI
var image = ee.Image('users/haifa/S2_NY_MedianComposite_2019');

// Visualization parameters for RGB display
var vizParams = {
  bands: ['B4_median', 'B3_median', 'B2_median'], // Red, Green, Blue
  min: 0,
  max: 3000,
  gamma: 1.4
};

// Add Sentinel-2 RGB layer to the map
Map.addLayer(image, vizParams, 'Sentinel-2 RGB');


//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 3. GEDI Data Processing
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Apply quality masks to GEDI L2A observations
// Only keeps shots where 'quality_flag' == 1 and 'degrade_flag' == 0
var qualityMask = function(im) {
  return im.updateMask(im.select('quality_flag').eq(1))
           .updateMask(im.select('degrade_flag').eq(0));
};

// Load GEDI L2A monthly data for the growing season (June–September 2019)
// Apply quality mask and clip to ROI
var gedi = ee.ImageCollection('LARSE/GEDI/GEDI02_A_002_MONTHLY')
              .map(qualityMask)
              .filterDate('2019-06-01', '2019-10-01')
              .map(function(im) { return im.clip(ROI); })
              .select(['rh.*', 'lat_highestreturn', 'lon_highestreturn']);

// Select the 95th percentile canopy height (RH95)
var gedi95 = gedi.select('rh95');

// Visualize GEDI RH95 on the map
Map.addLayer(
  gedi95, 
  {min: 1, max: 60, palette: 'darkred,red,orange,green,darkgreen'}, 
  'GEDI RH95'
);

// Compute median RH95 across the filtered period
var gediMedian = gedi95.median();

// Sample the median raster to create a FeatureCollection of point heights
// GEDI footprint: 25 m; includes geometry for each point
var gediSamples = gediMedian.sample({
  region: ROI,
  geometries: true,
  scale: 25
});


//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 4. Vegetation Indices Calculation
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// NDVI, NBR, NDMI selected for their sensitivity to vegetation structure, moisture, and disturbance,
// which improves canopy height prediction accuracy.

// NDVI - Normalized Difference Vegetation Index
// Rouse et al., 1974. Sensitive to vegetation greenness.
var ndvi = image.expression('((NIR - Red) / (NIR + Red))', {
  'NIR': image.select('B8_median'),
  'Red': image.select('B4_median')
}).rename('ndvi');

// NBR - Normalized Burn Ratio
// Key & Benson, 2006. Useful for burn severity and disturbance mapping.
var nbr = image.expression('((NIR - SWIR1) / (NIR + SWIR1))', {
  'NIR': image.select('B8_median'),
  'SWIR1': image.select('B11_median')
}).rename('nbr');

// NDMI - Normalized Difference Moisture Index
// Gao, 1996. Indicates canopy water content and vegetation moisture.
var ndmi = image.expression('((NIR - SWIR2) / (NIR + SWIR2))', {
  'NIR': image.select('B8_median'),
  'SWIR2': image.select('B12_median')
}).rename('ndmi');

// Stack all computed vegetation indices with original image bands
var stacked = image
  .addBands(ndvi)
  .addBands(nbr)
  .addBands(ndmi);

// Merge stacked indices with median GEDI layer
var stackedGEDI = gediMedian.addBands(stacked);


//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 5. Sample Sentinel-2 Data at GEDI Points
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Extract pixel values from stacked Sentinel-2 + indices image
// at the location of each GEDI sample point.
// We use `reduceRegion` to get the first value at each point (scale = 10 m).
var S2samples = gediSamples.map(function(feature) {
  return ee.Feature(feature.geometry(), stackedGEDI.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: feature.geometry(),
    scale: 10,
    tileScale: 16  // To avoid memory errors
  }));
});

// Export the sample points as an Earth Engine asset
// Export.table.toAsset({
//   collection: S2samples,
//   description: 'S2_features',
//   assetId: 'S2_features'
// });

//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 6. Prepare Training and Testing Samples (70/30 split)
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Filter out features with null RH95 values (invalid GEDI shots)
var validFeatures = S2samples.filter(ee.Filter.neq('rh95', null));

// Add a random column for splitting
var withRandom = validFeatures.randomColumn('random');

// 70% for training
var trainingSamples = withRandom.filter(ee.Filter.lt('random', 0.7));

// 30% for testing
var testingSamples = withRandom.filter(ee.Filter.gte('random', 0.7));

// Debug
print('Training samples count:', trainingSamples.size());
print('Testing samples count:', testingSamples.size());

// Export the training samples
Export.table.toDrive({
  collection: trainingSamples,
  description: 'GEDI_training_samples_NY_2019',
  folder: 'GEE_outputs',
  fileNamePrefix: 'gedi_training_samples_NY_2019',
  fileFormat: 'CSV'
});

// Export the testing samples
Export.table.toDrive({
  collection: testingSamples,
  description: 'GEDI_testing_samples_NY_2019',
  folder: 'GEE_outputs',
  fileNamePrefix: 'gedi_testing_samples_NY_2019',
  fileFormat: 'CSV'
});

//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 7. Train Random Forest Model
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Define input bands for training
var inputBands = ['B2_median','B3_median','B4_median','B5_median','B7_median',
'B8_median','B11_median','B12_median','ndvi','nbr','ndmi'];

// Sample predictor values from stacked Sentinel-2 + indices at training points
var training = stacked.sampleRegions({
  collection: trainingSamples,  // 70% training split
  properties: ['rh95'],         // target variable
  scale: 25
});

// Parameters:
// - numberOfTrees = 74: Provides stable regression results while 
//   controlling computation time. Chosen based on prior experience 
//   with GEDI + Sentinel-2 datasets.
// - minLeafPopulation = 3: Ensures each leaf has enough samples to 
//   reduce overfitting while preserving spatial detail.
// - bagFraction = 1: Uses all samples in each tree (no subsampling).
// - seed = 123: Fixes randomization for reproducibility.
//
// Note: These parameters are fixed for this workflow. While a full 
// grid search could be performed to optimize hyperparameters, it is 
// computationally expensive in Earth Engine and beyond the scope of 
// this script.


// Initialize and train Random Forest regression model
var RFmodel = ee.Classifier.smileRandomForest({
  numberOfTrees: 74,
  minLeafPopulation: 3,
  bagFraction: 1,
  seed: 123
})
.setOutputMode('REGRESSION')
.train({
  features: training,
  inputProperties: inputBands,
  classProperty: 'rh95'
});

var rfInfo = RFmodel.explain(); 
print('Random Forest Info:', rfInfo);

var featureImportance = rfInfo.get('importance');
print('Feature Importance:', featureImportance);

// Apply trained model to the input image
var prediction = stacked.classify(RFmodel).clip(ROI);

// Visualize predicted canopy height map (CHM)
Map.addLayer(prediction, {min: 0, max: 30, palette: ['blue','green','red']}, 'Predicted CHM');

//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// Optional: Evaluate model on testing subset (30%)
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
var testing = stacked.sampleRegions({
  collection: testingSamples,
  properties: ['rh95'],
  scale: 25
});

var testPred = testing.classify(RFmodel);

// Compute evaluation metrics (e.g., RMSE and MAE)
var rmse = testPred.aggregate_array('rh95')
  .zip(testPred.aggregate_array('classification'))
  .map(function(pair) {
    var obs = ee.Number(ee.List(pair).get(0));
    var pred = ee.Number(ee.List(pair).get(1));
    return pred.subtract(obs).pow(2);
  });
var rmseVal = ee.Number(rmse.reduce('mean')).sqrt();
print('Testing RMSE (m):', rmseVal);

var mae = testPred.aggregate_array('rh95')
  .zip(testPred.aggregate_array('classification'))
  .map(function(pair) {
    var obs = ee.Number(ee.List(pair).get(0));
    var pred = ee.Number(ee.List(pair).get(1));
    return pred.subtract(obs).abs(); // Absolute difference
  });
var maeVal = ee.Number(mae.reduce('mean'));
print('Testing MAE (m):', maeVal);

//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 8. Legend for CHM Output
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Visualization parameters for the predicted CHM layer
var vis = {
  min: 0,
  max: 30,
  palette: ['blue', 'green', 'red']
};

// Function to generate color bar parameters for legend visualization
function makeColorBarParams(palette) {
  return {
    bbox: [0, 0, 1, 0.1],
    dimensions: '100x10',
    format: 'png',
    min: 0,
    max: 1,
    palette: palette
  };
}

// Create a horizontal color bar thumbnail using the CHM palette
var colorBar = ui.Thumbnail({
  image: ee.Image.pixelLonLat().select(0),
  params: makeColorBarParams(vis.palette),
  style: {stretch: 'horizontal', margin: '0px 8px', maxHeight: '24px'}
});

// Create numeric labels for the color bar (min, mid, max)
var legendLabels = ui.Panel({
  widgets: [
    ui.Label(vis.min, {margin: '4px 8px'}),                    // min value
    ui.Label(vis.max / 2, {margin: '4px 8px', textAlign: 'center', stretch: 'horizontal'}),  // mid value
    ui.Label(vis.max, {margin: '4px 8px'})                     // max value
  ],
  layout: ui.Panel.Layout.flow('horizontal')
});

// Assemble and display the full legend panel on the map
var legendPanel = ui.Panel([
  ui.Label({value: 'Canopy Height Model (m)', style: {fontWeight: 'bold'}}),
  colorBar,
  legendLabels
]);

Map.add(legendPanel);  // Add legend to the map interface

//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 9. Export Final CHM Raster
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Export the final predicted Canopy Height Model (CHM) as a GeoTIFF to Google Drive

Export.image.toDrive({
  image: prediction,                    // The CHM prediction image
  description: 'CHM_RF_NY_2019',       // Task name for the export
  folder: 'GEE_outputs',
  fileNamePrefix: 'CHM_RF_NY_2019',
  scale: 10,                        // Spatial resolution in meters      
  maxPixels: 1e13,                 // Maximum number of pixels allowed
  crs: 'EPSG:5070',               // Target coordinate reference system (e.g., NAD83 / Conus Albers)
  region: ROI                    // Export region defined by the Region of Interest
});


//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 10. Export Evaluation Samples
//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

// Sample the predicted CHM values at the same locations as the reference GEDI rh95 samples
// This allows comparison between predicted and actual values for accuracy assessment
var evalSamples = prediction.sampleRegions({
  collection: testingSamples,     // Evaluation points 
  properties: ['rh95'],     // Reference canopy height values
  scale: 10                 // Sampling resolution
});

// Export the evaluation data as a CSV table to Google Drive
Export.table.toDrive({
  collection: evalSamples,
  description: 'S2CHM_RF_NY_2019_eval',        // Task name and output file name
  folder: 'GEE_outputs',
  fileNamePrefix: 'S2CHM_RF_NY_2019_eval',
  fileFormat: 'CSV'                            // File format for export
});


