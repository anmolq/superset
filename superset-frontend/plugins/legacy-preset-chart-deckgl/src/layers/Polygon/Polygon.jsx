/* eslint-disable react/sort-prop-types */
/* eslint-disable react/jsx-handler-names */
/* eslint-disable react/no-access-state-in-setstate */
/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
/* eslint no-underscore-dangle: ["error", { "allow": ["", "__timestamp"] }] */

import React from 'react';
import { t } from '@superset-ui/core';
import PropTypes from 'prop-types';

import { PolygonLayer } from 'deck.gl';

import AnimatableDeckGLContainer from '../../AnimatableDeckGLContainer';
import Legend from '../../components/Legend';
import TooltipRow from '../../TooltipRow';
import { getBuckets, getBreakPointColorScaler } from '../../utils';

import { commonLayerProps } from '../common';
import { getPlaySliderParams } from '../../utils/time';
import sandboxedEval from '../../utils/sandbox';
// eslint-disable-next-line import/extensions
import getPointsFromPolygon from '../../utils/getPointsFromPolygon';
// eslint-disable-next-line import/extensions
import fitViewport from '../../utils/fitViewport';

const DOUBLE_CLICK_THRESHOLD = 250; // milliseconds

function getElevation(d, colorScaler) {
  /* in deck.gl 5.3.4 (used in Superset as of 2018-10-24), if a polygon has
   * opacity zero it will make everything behind it have opacity zero,
   * effectively showing the map layer no matter what other polygons are
   * behind it.
   */
  return colorScaler(d)[3] === 0 ? 0 : d.elevation;
}

function setTooltipContent(formData) {
  return o => {
    const metricLabel = formData?.metric?.label || formData?.metric;

    return (
      <div className="deckgl-tooltip">
        {o.object?.name && (
          <TooltipRow
            // eslint-disable-next-line prefer-template
            label={t('name') + ': '}
            value={`${o.object.name}`}
          />
        )}
        {o.object?.[formData?.line_column] && (
          <TooltipRow
            label={`${formData.line_column}: `}
            value={`${o.object[formData.line_column]}`}
          />
        )}
        {formData?.metric && (
          <TooltipRow
            label={`${metricLabel}: `}
            value={`${o.object?.[metricLabel]}`}
          />
        )}
      </div>
    );
  };
}

export function getLayer(
  formData,
  payload,
  onAddFilter,
  setTooltip,
  selected,
  onSelect,
  filters,
) {
  const fd = formData;
  const fc = fd.fill_color_picker;
  const sc = fd.stroke_color_picker;
  let data = [...payload.data.features];

  if (filters != null) {
    filters.forEach(f => {
      data = data.filter(x => f(x));
    });
  }

  if (fd.js_data_mutator) {
    // Applying user defined data mutator if defined
    const jsFnMutator = sandboxedEval(fd.js_data_mutator);
    data = jsFnMutator(data);
  }

  const metricLabel = fd.metric ? fd.metric.label || fd.metric : null;
  const accessor = d => d[metricLabel];
  // base color for the polygons
  const baseColorScaler =
    fd.metric === null
      ? () => [fc.r, fc.g, fc.b, 255 * fc.a]
      : getBreakPointColorScaler(fd, data, accessor);

  // when polygons are selected, reduce the opacity of non-selected polygons
  const colorScaler = d => {
    const baseColor = baseColorScaler(d);
    if (selected.length > 0 && !selected.includes(d[fd.line_column])) {
      baseColor[3] /= 2;
    }

    return baseColor;
  };

  const tooltipContentGenerator =
    fd.line_column &&
    fd.metric &&
    ['json', 'geohash', 'zipcode'].includes(fd.line_type)
      ? setTooltipContent(fd)
      : undefined;

  return new PolygonLayer({
    id: `path-layer-${fd.slice_id}`,
    data,
    pickable: true,
    filled: fd.filled,
    stroked: fd.stroked,
    getPolygon: getPointsFromPolygon,
    getFillColor: colorScaler,
    getLineColor: [sc.r, sc.g, sc.b, 255 * sc.a],
    getLineWidth: fd.line_width,
    extruded: fd.extruded,
    getElevation: d => getElevation(d, colorScaler),
    elevationScale: fd.multiplier,
    fp64: true,
    ...commonLayerProps(fd, setTooltip, tooltipContentGenerator, onSelect),
  });
}

const propTypes = {
  formData: PropTypes.object.isRequired,
  payload: PropTypes.object.isRequired,
  setControlValue: PropTypes.func.isRequired,
  viewport: PropTypes.object.isRequired,
  onAddFilter: PropTypes.func,
  width: PropTypes.number.isRequired,
  height: PropTypes.number.isRequired,
};

const defaultProps = {
  onAddFilter() {},
};

class DeckGLPolygon extends React.Component {
  containerRef = React.createRef();

  constructor(props) {
    super(props);

    this.state = DeckGLPolygon.getDerivedStateFromProps(props);

    this.getLayers = this.getLayers.bind(this);
    this.onSelect = this.onSelect.bind(this);
    this.onValuesChange = this.onValuesChange.bind(this);
  }

  static getDerivedStateFromProps(props, state) {
    const { width, height, formData, payload } = props;

    // the state is computed only from the payload; if it hasn't changed, do
    // not recompute state since this would reset selections and/or the play
    // slider position due to changes in form controls
    if (state && payload.form_data === state.formData) {
      return null;
    }

    const features = payload.data.features || [];
    const timestamps = features.map(f => f.__timestamp);

    // the granularity has to be read from the payload form_data, not the
    // props formData which comes from the instantaneous controls state
    const granularity =
      payload.form_data.time_grain_sqla ||
      payload.form_data.granularity ||
      'P1D';

    const { start, end, getStep, values, disabled } = getPlaySliderParams(
      timestamps,
      granularity,
    );

    let { viewport } = props;
    if (formData.autozoom) {
      viewport = fitViewport(viewport, {
        width,
        height,
        points: features.flatMap(getPointsFromPolygon),
      });
    }

    return {
      start,
      end,
      getStep,
      values,
      disabled,
      viewport,
      selected: [],
      lastClick: 0,
      formData: payload.form_data,
    };
  }

  onSelect(polygon) {
    const { formData, onAddFilter } = this.props;

    const now = new Date();
    const doubleClick = now - this.state.lastClick <= DOUBLE_CLICK_THRESHOLD;

    // toggle selected polygons
    const selected = [...this.state.selected];
    if (doubleClick) {
      selected.splice(0, selected.length, polygon);
    } else if (formData.toggle_polygons) {
      const i = selected.indexOf(polygon);
      if (i === -1) {
        selected.push(polygon);
      } else {
        selected.splice(i, 1);
      }
    } else {
      selected.splice(0, 1, polygon);
    }

    this.setState({ selected, lastClick: now });
    if (formData.table_filter) {
      onAddFilter(formData.line_column, selected, false, true);
    }
  }

  onValuesChange(values) {
    this.setState({
      values: Array.isArray(values)
        ? values
        : [values, values + this.state.getStep(values)],
    });
  }

  getLayers(values) {
    if (this.props.payload.data.features === undefined) {
      return [];
    }

    const filters = [];

    // time filter
    if (values[0] === values[1] || values[1] === this.end) {
      filters.push(
        d => d.__timestamp >= values[0] && d.__timestamp <= values[1],
      );
    } else {
      filters.push(
        d => d.__timestamp >= values[0] && d.__timestamp < values[1],
      );
    }

    const layer = getLayer(
      this.props.formData,
      this.props.payload,
      this.props.onAddFilter,
      this.setTooltip,
      this.state.selected,
      this.onSelect,
      filters,
    );

    return [layer];
  }

  setTooltip = tooltip => {
    const { current } = this.containerRef;
    if (current) {
      current.setTooltip(tooltip);
    }
  };

  render() {
    const { payload, formData, setControlValue } = this.props;
    const { start, end, getStep, values, disabled, viewport } = this.state;

    const fd = formData;
    const metricLabel = fd.metric ? fd.metric.label || fd.metric : null;
    const accessor = d => d[metricLabel];

    const buckets = getBuckets(formData, payload.data.features, accessor);

    return (
      <div style={{ position: 'relative' }}>
        <AnimatableDeckGLContainer
          ref={this.containerRef}
          aggregation
          getLayers={this.getLayers}
          start={start}
          end={end}
          getStep={getStep}
          values={values}
          disabled={disabled}
          viewport={viewport}
          width={this.props.width}
          height={this.props.height}
          mapboxApiAccessToken={payload.data.mapboxApiKey}
          mapStyle={formData.mapbox_style}
          setControlValue={setControlValue}
          onValuesChange={this.onValuesChange}
          onViewportChange={this.onViewportChange}
        >
          {formData.metric !== null && (
            <Legend
              categories={buckets}
              position={formData.legend_position}
              format={formData.legend_format}
            />
          )}
        </AnimatableDeckGLContainer>
      </div>
    );
  }
}

DeckGLPolygon.propTypes = propTypes;
DeckGLPolygon.defaultProps = defaultProps;

export default DeckGLPolygon;
